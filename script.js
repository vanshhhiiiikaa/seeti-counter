// ---------- Recipe data ----------
// Whistle counts are typical guides, not exact science — they vary by
// cooker size, flame strength, and quantity of food.
const RECIPES = [
  { name: "Dal (toor/moong)",     whistles: 3,  accent: "#f4b400" },
  { name: "Dal Chawal",           whistles: 3,  accent: "#f4b400" },
  { name: "Rajma (soaked)",       whistles: 5,  accent: "#e6483a" },
  { name: "Rajma (unsoaked)",     whistles: 9,  accent: "#e6483a" },
  { name: "Peas Pulao",           whistles: 2,  accent: "#5fb85a" },
  { name: "Vegetable Pulao",      whistles: 2,  accent: "#5fb85a" },
  { name: "Chicken Biryani",      whistles: 2,  accent: "#f0862f" },
  { name: "Veg Biryani",          whistles: 3,  accent: "#f0862f" },
  { name: "Chole (soaked)",       whistles: 5,  accent: "#e6483a" },
  { name: "Khichdi",              whistles: 3,  accent: "#f4b400" },
  { name: "Plain Rice",           whistles: 2,  accent: "#5fb85a" },
];

// currentTarget: { name, whistles } — set either by picking a recipe card
// or by typing a custom whistle count. null means no target/alarm is set.
let currentTarget = null;
let hasAlarmed = false;

function renderRecipes() {
  const grid = document.getElementById("recipeGrid");
  grid.innerHTML = "";
  RECIPES.forEach((r) => {
    const card = document.createElement("div");
    card.className = "recipe-card";
    card.style.setProperty("--accent", r.accent);
    card.innerHTML = `
      <div class="recipe-name">${r.name}</div>
      <div class="recipe-whistles"><strong>${r.whistles}</strong> whistles</div>
    `;
    card.addEventListener("click", () => selectRecipe(r, card));
    grid.appendChild(card);
  });
}

function selectRecipe(recipe, cardEl) {
  document.querySelectorAll(".recipe-card").forEach((c) => c.classList.remove("selected"));
  cardEl.classList.add("selected");
  document.getElementById("customTarget").value = "";
  setTarget({ name: recipe.name, whistles: recipe.whistles });
}

function setTarget(target) {
  currentTarget = target;
  hasAlarmed = false;
  stopAlarm();
  updateTargetNote();
}

document.getElementById("setTargetBtn").addEventListener("click", () => {
  const input = document.getElementById("customTarget");
  const n = parseInt(input.value, 10);
  if (!n || n < 1) {
    input.focus();
    return;
  }
  document.querySelectorAll(".recipe-card").forEach((c) => c.classList.remove("selected"));
  setTarget({ name: "Your custom target", whistles: n });
});

function updateTargetNote() {
  const note = document.getElementById("targetNote");
  if (!currentTarget) {
    note.textContent = "Pick a recipe, or set your own target, to arm the alarm.";
    note.classList.remove("reached");
    return;
  }
  if (count >= currentTarget.whistles) {
    note.textContent = `${currentTarget.name} is done — ${currentTarget.whistles} whistles reached!`;
    note.classList.add("reached");
    if (!hasAlarmed) {
      hasAlarmed = true;
      startAlarm();
    }
  } else {
    const remaining = currentTarget.whistles - count;
    note.textContent = `${currentTarget.name}: ${remaining} more whistle${remaining === 1 ? "" : "s"} to go (target ${currentTarget.whistles}).`;
    note.classList.remove("reached");
    if (hasAlarmed) stopAlarm();
    hasAlarmed = false;
  }
}

// ---------- Alarm ----------
let alarmAudioCtx = null;
let alarmInterval = null;

function startAlarm() {
  if (alarmInterval) return;
  alarmAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const beep = () => {
    if (!alarmAudioCtx) return;
    const osc = alarmAudioCtx.createOscillator();
    const gain = alarmAudioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(alarmAudioCtx.destination);
    osc.start();
    osc.stop(alarmAudioCtx.currentTime + 0.25);
  };
  beep();
  alarmInterval = setInterval(beep, 500);
  document.getElementById("counterCard").classList.add("alarming");
  document.getElementById("stopAlarmBtn").hidden = false;
}

function stopAlarm() {
  if (alarmInterval) clearInterval(alarmInterval);
  alarmInterval = null;
  if (alarmAudioCtx) alarmAudioCtx.close();
  alarmAudioCtx = null;
  document.getElementById("counterCard").classList.remove("alarming");
  document.getElementById("stopAlarmBtn").hidden = true;
}

document.getElementById("stopAlarmBtn").addEventListener("click", stopAlarm);

// ---------- Counter ----------
let count = 0;
const countNumberEl = document.getElementById("countNumber");

function setCount(n) {
  count = Math.max(0, n);
  countNumberEl.textContent = count;
  countNumberEl.classList.add("pulse");
  setTimeout(() => countNumberEl.classList.remove("pulse"), 180);
  updateTargetNote();
}

document.getElementById("plusBtn").addEventListener("click", () => setCount(count + 1));
document.getElementById("minusBtn").addEventListener("click", () => setCount(count - 1));
document.getElementById("resetBtn").addEventListener("click", () => setCount(0));

// ---------- Mic-based whistle detection ----------
const listenBtn = document.getElementById("listenBtn");
const micStatus = document.getElementById("micStatus");
const sensitivitySlider = document.getElementById("sensitivity");

let audioCtx, analyser, dataArray, micStream, rafId;
let listening = false;

// State machine: 'idle' -> 'active' (loud) -> back to 'idle' counts one whistle,
// as long as the loud stretch lasted at least MIN_DURATION_MS.
let whistleState = "idle";
let activeStartTime = 0;
let lastCountTime = 0;
const MIN_DURATION_MS = 350;   // ignore short bangs/claps
const COOLDOWN_MS = 900;       // ignore re-triggers right after a count

function sensitivityToThresholds() {
  // slider 1 (least sensitive) .. 10 (most sensitive)
  const s = Number(sensitivitySlider.value);
  const high = 0.34 - (s - 1) * 0.022; // rises trigger "active"
  const low = high * 0.55;             // must fall back below this to reset
  return { high, low };
}

function getVolume() {
  analyser.getByteTimeDomainData(dataArray);
  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / dataArray.length); // RMS, roughly 0–1
}

function monitor() {
  if (!listening) return;
  const volume = getVolume();
  const { high, low } = sensitivityToThresholds();
  const now = performance.now();

  if (whistleState === "idle" && volume > high && now - lastCountTime > COOLDOWN_MS) {
    whistleState = "active";
    activeStartTime = now;
  } else if (whistleState === "active" && volume < low) {
    const duration = now - activeStartTime;
    whistleState = "idle";
    if (duration >= MIN_DURATION_MS) {
      lastCountTime = now;
      setCount(count + 1);
    }
  }

  rafId = requestAnimationFrame(monitor);
}

async function startListening() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    micStatus.textContent = "Couldn't access the microphone — check your browser's mic permission.";
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  dataArray = new Uint8Array(analyser.fftSize);
  source.connect(analyser);

  listening = true;
  whistleState = "idle";
  listenBtn.textContent = "⏸ Stop Listening";
  listenBtn.classList.add("active");
  micStatus.textContent = "Listening for the whistle… keep the mic near the cooker.";
  monitor();
}

function stopListening() {
  listening = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  listenBtn.textContent = "🎙️ Start Listening";
  listenBtn.classList.remove("active");
  micStatus.textContent = "";
}

listenBtn.addEventListener("click", () => {
  if (listening) {
    stopListening();
  } else {
    startListening();
  }
});

// ---------- Init ----------
renderRecipes();
updateTargetNote();
