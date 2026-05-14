import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { ScanFace, ShieldAlert, Siren } from "lucide-react";
import type { FaceMesh as FaceMeshClass } from "@mediapipe/face_mesh";

declare global {
  interface Window {
    FaceMesh?: typeof FaceMeshClass;
  }
}

type MonitorStatus = "booting" | "requesting" | "tracking" | "blocked" | "offline";

type Landmark = {
  x: number;
  y: number;
  z?: number;
};

type FaceMeshResults = {
  multiFaceLandmarks?: Landmark[][];
};

type SmileMetrics = {
  score: number;
  mouthWidth: number;
  cornerLift: number;
  baseline: number;
};

const leftMouth = 61;
const rightMouth = 291;
const upperLip = 13;
const lowerLip = 14;
const noseTop = 168;
const chin = 152;
const leftEyeOuter = 33;
const rightEyeOuter = 263;
const redirectSessionKey = "lock-in-twin-max-escalation-redirected";
const minInsultsBeforeMaxEscalation = 5;
let speechInProgress = false;

function distance(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pickMessage(messages: string[]) {
  if (messages.length === 0) {
    return "NO INSULTS FOUND IN INSULTS.TXT.";
  }

  return messages[Math.floor(Math.random() * messages.length)];
}

function shuffleMessages(messages: string[]) {
  const shuffled = [...messages];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled;
}

function sameMessages(a: string[], b: string[]) {
  return a.length === b.length && a.every((message, index) => message === b[index]);
}

function redirectToEscalationVideo() {
  window.sessionStorage.setItem(redirectSessionKey, "true");
  window.location.assign("https://www.youtube.com/watch?v=E9T78bT26sk&t=203s");
}

async function loadInsultsFromFile() {
  const response = await fetch(`/insults.txt?cacheBust=${Date.now()}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Could not load insults.txt: ${response.status}`);
  }

  const text = await response.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function computeSmileMetrics(landmarks: Landmark[], lockedInMode: boolean, baselineWidth: number | null): SmileMetrics {
  const faceHeight = Math.max(distance(landmarks[noseTop], landmarks[chin]), 0.001);
  const eyeWidth = Math.max(distance(landmarks[leftEyeOuter], landmarks[rightEyeOuter]), 0.001);
  const mouthWidth = distance(landmarks[leftMouth], landmarks[rightMouth]) / eyeWidth;
  const mouthOpen = distance(landmarks[upperLip], landmarks[lowerLip]) / faceHeight;
  const mouthCenterY = (landmarks[upperLip].y + landmarks[lowerLip].y) / 2;
  const cornerY = (landmarks[leftMouth].y + landmarks[rightMouth].y) / 2;
  const cornerLift = (mouthCenterY - cornerY) / faceHeight;
  const baseline = baselineWidth ?? mouthWidth;
  const widthDelta = mouthWidth - baseline;
  const widthSignal = (widthDelta - (lockedInMode ? 0.015 : 0.022)) / (lockedInMode ? 0.07 : 0.08);
  const liftSignal = (cornerLift - (lockedInMode ? 0.004 : 0.008)) / 0.04;
  const openPenalty = clamp((mouthOpen - 0.13) * 1.5, 0, 0.22);
  const score = clamp(widthSignal * 0.72 + Math.max(liftSignal, 0) * 0.28 - openPenalty, 0, 1);

  return {
    score,
    mouthWidth,
    cornerLift,
    baseline,
  };
}

function createAlertSound(severity: number) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  const context = new AudioContextClass();
  const now = context.currentTime;
  const gain = context.createGain();
  const filter = context.createBiquadFilter();

  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.16 + severity * 0.1, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);
  filter.type = "bandpass";
  filter.frequency.value = 900 + severity * 900;
  filter.Q.value = 9;
  filter.connect(gain);
  gain.connect(context.destination);

  [0, 0.12, 0.24].forEach((offset, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = index % 2 ? "square" : "sawtooth";
    oscillator.frequency.setValueAtTime(280 + severity * 220 + index * 90, now + offset);
    oscillator.frequency.exponentialRampToValueAtTime(520 + severity * 460, now + offset + 0.08);
    oscillator.connect(filter);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.1);
  });

  window.setTimeout(() => void context.close(), 700);
}

function speakCallout(text: string, onDone?: () => void) {
  if (!("speechSynthesis" in window)) return true;
  if (speechInProgress) return false;

  speechInProgress = true;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = 0.72;
  utterance.volume = 1;
  utterance.onend = () => {
    speechInProgress = false;
    onDone?.();
  };
  utterance.onerror = () => {
    speechInProgress = false;
    onDone?.();
  };
  window.speechSynthesis.speak(utterance);

  return true;
}

function StatusPill({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="border border-white/10 bg-black/55 px-3 py-2 font-mono uppercase tracking-[0.12em] backdrop-blur">
      <div className="text-[9px] text-zinc-500">{label}</div>
      <div className={`mt-1 text-xs ${danger ? "text-red-300" : "text-cyan-200"}`}>{value}</div>
    </div>
  );
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const faceMeshRef = useRef<FaceMeshClass | null>(null);
  const rafRef = useRef<number>();
  const streamRef = useRef<MediaStream | null>(null);
  const smileStartedAt = useRef<number | null>(null);
  const smileCandidateStartedAt = useRef<number | null>(null);
  const lastVideoTime = useRef(-1);
  const neutralWidthRef = useRef<number | null>(null);
  const neutralSamplesRef = useRef(0);
  const neutralWidthTotalRef = useRef(0);
  const calloutLoadingRef = useRef(false);
  const deliveredInsultsRef = useRef(0);
  const pendingRepeatCalloutRef = useRef(false);
  const redirectedRef = useRef(false);
  const smoothedScoreRef = useRef(0);
  const insultSourceRef = useRef<string[]>([]);
  const insultBagRef = useRef<string[]>([]);
  const controls = useAnimationControls();

  const [status, setStatus] = useState<MonitorStatus>("booting");
  const [lockedInMode, setLockedInMode] = useState(false);
  const [smileScore, setSmileScore] = useState(0);
  const [smileDuration, setSmileDuration] = useState(0);
  const [violations, setViolations] = useState(0);
  const [focusScore, setFocusScore] = useState(100);
  const [message, setMessage] = useState("Maintain a neutral productivity face.");
  const [cameraError, setCameraError] = useState("");
  const [insultCount, setInsultCount] = useState<number | null>(null);
  const [debugMetrics, setDebugMetrics] = useState<SmileMetrics>({
    score: 0,
    mouthWidth: 0,
    cornerLift: 0,
    baseline: 0,
  });

  const severity = clamp(smileScore * 0.55 + Math.min(smileDuration / 5, 1) * 0.45, 0, 1);
  const smiling = smileStartedAt.current !== null && smileScore > (lockedInMode ? 0.12 : 0.16);

  useEffect(() => {
    redirectedRef.current = window.sessionStorage.getItem(redirectSessionKey) === "true";

    function handlePageShow() {
      if (window.sessionStorage.getItem(redirectSessionKey) !== "true") return;

      redirectedRef.current = true;
      smileCandidateStartedAt.current = null;
      smileStartedAt.current = null;
      pendingRepeatCalloutRef.current = false;
      smoothedScoreRef.current = 0;
      setSmileScore(0);
      setSmileDuration(0);
      setMessage("Maintain a neutral productivity face.");
      window.speechSynthesis?.cancel();
    }

    window.addEventListener("pageshow", handlePageShow);

    return () => {
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  const triggerCallout = useCallback(
    async (nextSeverity: number, shake: number[], repeatWhileSmiling = true) => {
      if (calloutLoadingRef.current || speechInProgress) return false;

      calloutLoadingRef.current = true;
      try {
        const fileMessages = await loadInsultsFromFile();
        setInsultCount(fileMessages.length);
        if (!sameMessages(fileMessages, insultSourceRef.current)) {
          insultSourceRef.current = fileMessages;
          insultBagRef.current = shuffleMessages(fileMessages);
        }

        if (insultBagRef.current.length === 0) {
          insultBagRef.current = shuffleMessages(fileMessages);
        }

        const nextMessage = insultBagRef.current.shift() ?? pickMessage(fileMessages);
        console.info("TXT INSULT SELECTED:", nextMessage);

        if (
          !speakCallout(nextMessage, () => {
            if (!repeatWhileSmiling || pendingRepeatCalloutRef.current || smileStartedAt.current === null) return;

            pendingRepeatCalloutRef.current = true;
            window.setTimeout(() => {
              pendingRepeatCalloutRef.current = false;
              if (smileStartedAt.current !== null) {
                void triggerCallout(clamp(smoothedScoreRef.current, 0.25, 1), [0, -7, 6, -4, 0], true);
              }
            }, 180);
          })
        ) {
          return false;
        }

        deliveredInsultsRef.current += 1;
        setViolations((count) => count + 1);
        setMessage(nextMessage);
        createAlertSound(nextSeverity);
        void controls.start({
          x: shake,
          transition: { duration: 0.42 },
        });

        return true;
      } catch (error) {
        setInsultCount(0);
        console.warn("Could not pick an insult from /insults.txt.", error);
        return false;
      } finally {
        calloutLoadingRef.current = false;
      }
    },
    [controls],
  );

  useEffect(() => {
    let mounted = true;

    async function checkInsultFile() {
      try {
        const fileMessages = await loadInsultsFromFile();
        if (mounted) {
          setInsultCount(fileMessages.length);
          console.info("insults.txt currently has:", fileMessages);
        }
      } catch (error) {
        if (mounted) setInsultCount(0);
        console.warn("Could not read /insults.txt.", error);
      }
    }

    void checkInsultFile();

    return () => {
      mounted = false;
    };
  }, []);

  const runDetection = useCallback(async () => {
    const video = videoRef.current;
    const faceMesh = faceMeshRef.current;

    if (!video || !faceMesh || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }

    if (video.currentTime !== lastVideoTime.current) {
      lastVideoTime.current = video.currentTime;
      await faceMesh.send({ image: video });
    }

    rafRef.current = requestAnimationFrame(runDetection);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setStatus("requesting");
      neutralWidthRef.current = null;
      neutralSamplesRef.current = 0;
      neutralWidthTotalRef.current = 0;
      deliveredInsultsRef.current = 0;
      smileCandidateStartedAt.current = null;
      smileStartedAt.current = null;
      pendingRepeatCalloutRef.current = false;
      smoothedScoreRef.current = 0;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user",
          },
          audio: false,
        });

        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        await video.play();

        if (!window.FaceMesh) {
          throw new Error("FaceMesh failed to load.");
        }

        const faceMesh = new window.FaceMesh({
          locateFile: (file) => `/mediapipe/face_mesh/${file}`,
        });

        faceMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.62,
          minTrackingConfidence: 0.62,
        });

        faceMesh.onResults((results: FaceMeshResults) => {
          const landmarks = results.multiFaceLandmarks?.[0];
          const now = performance.now();

          if (!landmarks) {
            smoothedScoreRef.current = 0;
            setSmileScore(0);
            smileCandidateStartedAt.current = null;
            smileStartedAt.current = null;
            setSmileDuration(0);
            return;
          }

          if (neutralSamplesRef.current < 50) {
            const neutralMetrics = computeSmileMetrics(landmarks, lockedInMode, null);
            neutralWidthTotalRef.current += neutralMetrics.mouthWidth;
            neutralSamplesRef.current += 1;
            neutralWidthRef.current = neutralWidthTotalRef.current / neutralSamplesRef.current;
            smoothedScoreRef.current = 0;
            setSmileScore(0);
            setSmileDuration(0);
            setDebugMetrics({
              ...neutralMetrics,
              score: 0,
              baseline: neutralWidthRef.current,
            });
            return;
          }

          const metrics = landmarks
            ? computeSmileMetrics(landmarks, lockedInMode, neutralWidthRef.current)
            : { score: 0, mouthWidth: 0, cornerLift: 0, baseline: neutralWidthRef.current ?? 0 };
          const nextScore = metrics.score;

          setDebugMetrics({
            ...metrics,
            baseline: neutralWidthRef.current ?? metrics.baseline,
          });
          const smoothedScore = smoothedScoreRef.current * 0.78 + nextScore * 0.22;
          smoothedScoreRef.current = smoothedScore;
          setSmileScore(smoothedScore);

          const triggerThreshold = lockedInMode ? 0.12 : 0.16;
          const releaseThreshold = lockedInMode ? 0.05 : 0.07;
          const requiredSmileMs = lockedInMode ? 60 : 80;

          if (smoothedScore >= triggerThreshold) {
            if (smileCandidateStartedAt.current === null) {
              smileCandidateStartedAt.current = now;
            }

            const candidateDuration = now - smileCandidateStartedAt.current;
            if (candidateDuration < requiredSmileMs) {
              setSmileDuration(0);
              return;
            }

            if (smileStartedAt.current === null) {
              smileStartedAt.current = now;
              void triggerCallout(clamp(smoothedScore, 0.25, 1), [0, -12, 10, -7, 4, 0]);
            }

            const duration = (now - smileStartedAt.current) / 1000;
            const nextSeverity = clamp(smoothedScore * 0.55 + Math.min(duration / 5, 1) * 0.45, 0, 1);

            setSmileDuration(duration);
            setFocusScore((score) => clamp(score - (0.28 + nextSeverity * 0.62), 0, 100));

            if (
              !redirectedRef.current &&
              deliveredInsultsRef.current >= minInsultsBeforeMaxEscalation &&
              Math.ceil(nextSeverity * 10) >= 10
            ) {
              redirectedRef.current = true;
              smileCandidateStartedAt.current = null;
              smileStartedAt.current = null;
              pendingRepeatCalloutRef.current = false;
              smoothedScoreRef.current = 0;
              window.speechSynthesis?.cancel();
              redirectToEscalationVideo();
            }

          } else if (smoothedScore <= releaseThreshold) {
            smileCandidateStartedAt.current = null;
            smileStartedAt.current = null;
            pendingRepeatCalloutRef.current = false;
            setSmileDuration(0);
            setFocusScore((score) => clamp(score + 0.035, 0, 100));
          } else {
            setFocusScore((score) => clamp(score + 0.02, 0, 100));
          }
        });

        faceMeshRef.current = faceMesh;
        setStatus("tracking");
        rafRef.current = requestAnimationFrame(runDetection);
      } catch (error) {
        setStatus("blocked");
        setCameraError(error instanceof Error ? error.message : "Camera permission was denied.");
      }
    }

    void boot();

    return () => {
      mounted = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      faceMeshRef.current?.close();
    };
  }, [lockedInMode, runDetection, triggerCallout]);

  return (
    <motion.main
      animate={controls}
      className="relative min-h-screen overflow-hidden bg-zinc-950 font-mono text-zinc-100"
      style={{
        filter: smiling ? `contrast(${1.05 + severity * 0.25}) saturate(${0.88 + severity * 0.55})` : undefined,
      }}
    >
      <video ref={videoRef} className="absolute inset-0 h-full w-full scale-x-[-1] object-cover opacity-80" playsInline muted />

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.08),transparent_28%),linear-gradient(90deg,rgba(0,255,255,0.05),transparent_28%,rgba(255,0,64,0.08))]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px)] bg-[length:100%_4px] opacity-35 mix-blend-overlay" />
      <div className="pointer-events-none absolute left-0 right-0 top-0 h-24 animate-scan bg-gradient-to-b from-transparent via-cyan-300/20 to-transparent" />

      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150"
        style={{ opacity: smiling ? 0.18 + severity * 0.32 : 0, background: "rgba(255, 0, 48, 1)" }}
      />

      <section className="relative z-10 flex min-h-screen flex-col justify-between p-4 sm:p-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 border border-red-500/35 bg-black/60 px-3 py-2 shadow-alert backdrop-blur">
            <ShieldAlert size={22} className="text-red-200" />
            <div>
              <p className="text-[9px] uppercase tracking-[0.28em] text-red-300/80">Focus Monitor</p>
              <h1 className="text-xl font-black uppercase tracking-[0.08em] text-white sm:text-2xl">Lock In Twin</h1>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <StatusPill label="Camera" value={status === "tracking" ? "armed" : status} danger={status === "blocked"} />
            <StatusPill label="Violations" value={String(violations)} danger={violations > 0} />
            <StatusPill label="Focus" value={`${Math.round(focusScore)}%`} danger={focusScore < 65} />
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-4xl text-center">
            <AnimatePresence mode="wait">
              {smiling ? (
                <motion.div
                  key={message}
                  initial={{ opacity: 0, scale: 0.78, y: 18 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.92, y: -12 }}
                  transition={{ duration: 0.18 }}
                  className="relative overflow-hidden border-2 border-red-500 bg-black/72 p-5 shadow-alert backdrop-blur sm:p-8"
                >
                  <div className="absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,0,64,0.24),transparent)]" />
                  <div className="relative">
                    <Siren className="mx-auto text-red-100" size={42} />
                    <p className="mt-4 animate-glitch text-[10px] font-bold uppercase tracking-[0.42em] text-red-200">
                      Unauthorized joy event
                    </p>
                    <h2 className="mt-3 text-2xl font-black uppercase tracking-[0.24em] text-red-200 sm:text-4xl">
                      Smile Detected
                    </h2>
                    <p
                      aria-live="assertive"
                      className="mx-auto mt-5 max-w-3xl text-balance break-words text-[clamp(1.65rem,4.8vw,3.75rem)] font-black uppercase leading-[1.02] tracking-[0.01em] text-white"
                    >
                      {message}
                    </p>
                    <div className="mx-auto mt-6 h-2 max-w-lg overflow-hidden bg-red-950/80">
                      <motion.div
                        className="h-full bg-red-400"
                        animate={{ width: `${Math.max(10, severity * 100)}%` }}
                        transition={{ duration: 0.12 }}
                      />
                    </div>
                    <p className="mt-3 text-[10px] uppercase tracking-[0.28em] text-red-200/80">
                      escalation {Math.ceil(severity * 10).toString().padStart(2, "0")} · hold {smileDuration.toFixed(1)}s
                    </p>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed bottom-24 left-1/2 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 border border-white/10 bg-black/42 p-4 backdrop-blur sm:bottom-20"
                >
                  <p className="text-[10px] uppercase tracking-[0.34em] text-cyan-200">Local webcam tracking</p>
                  <p className="mt-2 text-2xl font-black uppercase text-white sm:text-4xl">Maintain a neutral productivity face.</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <footer />
      </section>

      {status !== "tracking" && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/82 p-6 text-center backdrop-blur">
          <div className="max-w-xl border border-cyan-300/35 bg-zinc-950 p-6 shadow-[0_0_40px_rgba(34,211,238,0.18)]">
            <ScanFace className="mx-auto text-cyan-200" size={42} />
            <h2 className="mt-4 text-3xl font-black uppercase tracking-[0.12em] text-white">Booting Focus Tribunal</h2>
            <p className="mt-3 text-sm uppercase leading-6 tracking-[0.14em] text-zinc-400">
              {status === "blocked"
                ? "Camera access is required for absurd real-time accountability."
                : "Requesting webcam permission and loading local face landmarks."}
            </p>
            {cameraError && <p className="mt-4 text-xs text-red-300">{cameraError}</p>}
          </div>
        </div>
      )}
    </motion.main>
  );
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
