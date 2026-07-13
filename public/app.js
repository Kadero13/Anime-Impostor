"use strict";

const $ = (id) => document.getElementById(id);
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 20;
const TAB_CHANNEL_NAME = "anime-imposteur-v16-tabs";
const MAX_RENDERED_MESSAGES = 35;

let playerToken = sessionStorage.getItem("imposteurPlayerToken");
if (!playerToken) {
    playerToken = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");
    sessionStorage.setItem("imposteurPlayerToken", playerToken);
}

const socket = io({
    auth: { playerToken },
    transports: ["websocket"],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    reconnectionDelayMax: 5000
});

let currentRoom = sessionStorage.getItem("imposteurRoom") || "";
let username = localStorage.getItem("imposteurName") || "";
let isHost = false;
let hostToken = "";
let roomSettings = {};
let players = [];
let myCard = null;
let currentRound = 0;
let cardRevealed = false;
let alreadyVoted = false;
let selectedVoteId = null;
let phaseDeadline = null;
let currentPhase = "lobby";
let currentSpeakerToken = null;
let timerInterval = null;
let cardHideTimeout = null;
let soundEnabled = localStorage.getItem("imposteurSound") !== "off";
let audioContext = null;
let lowPowerMode = false;
let pendingRoomState = null;
let installPrompt = null;
let confirmCallback = null;
let gameIsOpen = false;
let playersRenderKey = "";
let settingsRenderKey = "";
let wheelRenderKey = "";
let lastTimerSecond = null;
let pendingChatMessages = [];
let tabTokenConflictHandled = false;
let reconnectRequestTimer = null;

const tabId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const tabStartedAt = performance.timeOrigin || Date.now();
const peerTabs = new Set();
const tabChannel = "BroadcastChannel" in window ? new BroadcastChannel(TAB_CHANNEL_NAME) : null;

window.addEventListener("DOMContentLoaded", () => {
    if (username) $("username").value = username;
    const queryRoom = new URLSearchParams(location.search).get("room");
    if (queryRoom) $("roomCode").value = queryRoom.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    bindControls();
    updateSoundButton();
    updateLocalStats();
    setupPerformanceMode();
    registerServiceWorker();
});

window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    $("installButton").hidden = false;
});

window.addEventListener("beforeunload", (event) => {
    if (!currentRoom) return;
    event.preventDefault();
    event.returnValue = "";
});

function bindControls() {
    $("toggleAllCategories").addEventListener("click", () => {
        const boxes = [...document.querySelectorAll(".category")];
        const shouldCheck = boxes.some((box) => !box.checked);
        for (const box of boxes) box.checked = shouldCheck;
        $("toggleAllCategories").textContent = shouldCheck ? "Tout désélectionner" : "Tout sélectionner";
    });

    $("chatInput").addEventListener("keydown", (event) => {
        if (event.key === "Enter") sendChat();
    });

    $("roomCode").addEventListener("input", (event) => {
        event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });

    $("soundToggle").addEventListener("click", () => {
        soundEnabled = !soundEnabled;
        localStorage.setItem("imposteurSound", soundEnabled ? "on" : "off");
        updateSoundButton();
        if (soundEnabled) playSound("click");
    });

    $("gameMode").addEventListener("change", updateModeFields);
    $("roomMode").addEventListener("change", updateRoomModeFields);
    $("installButton").addEventListener("click", installApp);

    $("players").addEventListener("click", (event) => {
        const actionButton = event.target.closest("button[data-player-action]");
        if (!actionButton) return;
        const token = actionButton.dataset.token;
        const action = actionButton.dataset.playerAction;
        const target = players.find((player) => player.token === token);
        if (!target) return;

        if (action === "kick") {
            openConfirm("Expulser ce joueur ?", `${target.name} sera retiré de la room.`, () => {
                socket.emit("kickPlayer", { code: currentRoom, token });
            });
        }
        if (action === "host") {
            openConfirm("Transférer le rôle d’hôte ?", `${target.name} contrôlera désormais la partie.`, () => {
                socket.emit("transferHost", { code: currentRoom, token });
            });
        }
    });

    document.addEventListener("visibilitychange", () => {
        updatePerformanceMode();
        restartTimerLoop();
        if (document.hidden) {
            audioContext?.suspend?.();
            return;
        }
        if (currentRoom && socket.connected) socket.emit("requestSync", currentRoom);
        flushPendingChat();
    });

    $("voteGrid").addEventListener("click", (event) => {
        const button = event.target.closest("button.vote-player");
        if (!button || alreadyVoted || button.disabled) return;
        const previous = $("voteGrid").querySelector(".vote-player.selected");
        if (previous && previous !== button) previous.classList.remove("selected");
        button.classList.add("selected");
        selectedVoteId = button.dataset.token;
        $("voteButton").disabled = false;
    });

    updateModeFields();
}

function setupPerformanceMode() {
    document.documentElement.classList.add("performance-v16");
    if (!tabChannel) {
        updatePerformanceMode();
        return;
    }

    tabChannel.onmessage = (event) => {
        const data = event.data || {};
        if (!data.id || data.id === tabId) return;

        if (data.type === "hello") {
            peerTabs.add(data.id);
            tabChannel.postMessage({ type: "present", id: tabId, token: playerToken, startedAt: tabStartedAt });
            if (data.token === playerToken && tabStartedAt < Number(data.startedAt || Infinity)) {
                tabChannel.postMessage({ type: "token-conflict", id: tabId, target: data.id, token: playerToken });
            }
        } else if (data.type === "present") {
            peerTabs.add(data.id);
            if (data.token === playerToken && tabStartedAt > Number(data.startedAt || 0)) {
                handleDuplicatedTabIdentity();
            }
        } else if (data.type === "bye") {
            peerTabs.delete(data.id);
        } else if (data.type === "token-conflict" && data.target === tabId && data.token === playerToken) {
            handleDuplicatedTabIdentity();
        }
        updatePerformanceMode();
    };

    tabChannel.postMessage({ type: "hello", id: tabId, token: playerToken, startedAt: tabStartedAt });
    window.addEventListener("pagehide", () => tabChannel.postMessage({ type: "bye", id: tabId }));
    updatePerformanceMode();
}

function handleDuplicatedTabIdentity() {
    if (tabTokenConflictHandled) return;
    tabTokenConflictHandled = true;
    const roomToJoin = currentRoom || new URLSearchParams(location.search).get("room") || "";
    playerToken = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");
    sessionStorage.setItem("imposteurPlayerToken", playerToken);
    sessionStorage.removeItem("imposteurRoom");
    currentRoom = "";
    socket.auth = { playerToken };
    socket.disconnect();
    const target = roomToJoin ? `/?room=${encodeURIComponent(roomToJoin)}` : "/";
    location.replace(target);
}

function updatePerformanceMode() {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    lowPowerMode = Boolean(document.hidden || peerTabs.size > 0 || reduced);
    document.documentElement.classList.toggle("low-power", lowPowerMode);
    $("performanceBadge").hidden = document.hidden;
    $("performanceBadge").textContent = lowPowerMode ? "Mode ultra léger" : "Mode optimisé";
}

function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
}

async function installApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    $("installButton").hidden = true;
}

function updateModeFields() {
    const custom = $("gameMode").value === "custom";
    $("customSubjectsBlock").hidden = !custom;
    document.querySelectorAll(".category, .difficulty, #linkedMix").forEach((element) => {
        element.disabled = custom;
    });
    if ($("gameMode").value === "fast") {
        $("time").value = "15";
        $("cardTime").value = "3";
    }
    if ($("gameMode").value === "duo" && Number($("impostors").value) < 2) $("impostors").value = "2";
}

function updateSoundButton() {
    $("soundToggle").setAttribute("aria-pressed", String(soundEnabled));
    $("soundIcon").textContent = soundEnabled ? "♪" : "×";
    $("soundLabel").textContent = soundEnabled ? "Sons activés" : "Sons coupés";
}

function getAudioContext() {
    if (!soundEnabled || document.hidden) return null;
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    return audioContext;
}

function tone(frequency, start, duration, volume = 0.025, type = "sine") {
    const context = getAudioContext();
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, context.currentTime + start);
    gain.gain.setValueAtTime(0.0001, context.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(context.currentTime + start);
    oscillator.stop(context.currentTime + start + duration + 0.03);
}

function playSound(name) {
    if (!soundEnabled || lowPowerMode) return;
    const patterns = {
        click: [[460, 0, .07, .02, "sine"]],
        launch: [[220, 0, .15, .025, "sine"], [340, .11, .17, .025, "sine"], [520, .23, .2, .03, "triangle"]],
        reveal: [[300, 0, .1, .025, "triangle"], [620, .07, .17, .03, "sine"]],
        turn: [[420, 0, .08, .02, "sine"], [560, .09, .14, .025, "sine"]],
        vote: [[180, 0, .18, .03, "triangle"], [240, .15, .2, .03, "triangle"]],
        eliminate: [[310, 0, .1, .035, "sawtooth"], [210, .1, .16, .035, "sawtooth"], [120, .24, .3, .04, "sine"]],
        success: [[440, 0, .1, .025, "sine"], [660, .1, .13, .03, "sine"], [880, .21, .2, .03, "sine"]]
    };
    for (const values of patterns[name] || patterns.click) tone(...values);
}

function vibrate(pattern) {
    if (!document.hidden && navigator.vibrate) navigator.vibrate(pattern);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.hidden = false;
    toast.classList.remove("toast-out");
    requestAnimationFrame(() => toast.classList.add("toast-in"));
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        toast.classList.add("toast-out");
        setTimeout(() => {
            toast.hidden = true;
            toast.classList.remove("toast-in", "toast-out");
        }, 220);
    }, 2500);
}

function playCinematic({ icon = "I", eyebrow = "", title = "", text = "", duration = 1400, toneName = "default" }) {
    if (lowPowerMode || document.hidden) return;
    const overlay = $("cinematicOverlay");
    $("cinematicIcon").textContent = icon;
    $("cinematicEyebrow").textContent = eyebrow;
    $("cinematicTitle").textContent = title;
    $("cinematicText").textContent = text;
    overlay.dataset.tone = toneName;
    overlay.hidden = false;
    overlay.classList.remove("cinematic-out");
    requestAnimationFrame(() => overlay.classList.add("cinematic-in"));
    clearTimeout(playCinematic.timer);
    playCinematic.timer = setTimeout(() => {
        overlay.classList.add("cinematic-out");
        setTimeout(() => {
            overlay.hidden = true;
            overlay.classList.remove("cinematic-in", "cinematic-out");
        }, 320);
    }, duration);
}

function saveName() {
    username = $("username").value.trim();
    localStorage.setItem("imposteurName", username);
}

function getCategories() {
    return [...document.querySelectorAll(".category:checked")].map((item) => item.value);
}

function getDifficulties() {
    return [...document.querySelectorAll(".difficulty:checked")].map((item) => item.value);
}

function collectSettings() {
    return {
        categories: getCategories(),
        difficulties: getDifficulties(),
        linkedMix: $("linkedMix").checked,
        mode: $("gameMode").value,
        time: Number($("time").value),
        cardTime: Number($("cardTime").value),
        impostors: Number($("impostors").value),
        customSubjects: $("customSubjects").value
    };
}

function createRoom() {
    saveName();
    const settings = collectSettings();
    if (!username) return showToast("Entre un pseudo.");
    if (settings.mode !== "custom" && !settings.categories.length) return showToast("Choisis au moins une catégorie.");
    if (settings.mode !== "custom" && !settings.difficulties.length) return showToast("Choisis au moins une difficulté.");
    if (settings.mode === "custom" && settings.customSubjects.split(/\r?\n/).filter((line) => line.trim()).length < 2) {
        return showToast("Ajoute au moins deux sujets personnalisés.");
    }
    playSound("click");
    socket.emit("createRoom", { name: username, ...settings });
}

function joinRoom() {
    saveName();
    const code = $("roomCode").value.trim().toUpperCase();
    if (!username) return showToast("Entre un pseudo.");
    if (code.length !== 6) return showToast("Entre un code de room valide.");
    playSound("click");
    socket.emit("joinRoom", { name: username, code });
}

function openGame() {
    if (!gameIsOpen) {
        $("login").hidden = true;
        $("game").hidden = false;
        gameIsOpen = true;
        window.scrollTo(0, 0);
    }
    if ($("roomCodeDisplay").textContent !== currentRoom) $("roomCodeDisplay").textContent = currentRoom;
    const nextUrl = `/?room=${encodeURIComponent(currentRoom)}`;
    if (`${location.pathname}${location.search}` !== nextUrl) history.replaceState(null, "", nextUrl);
    refreshHostUi();
    displaySettings();
}

function resetToLogin(message) {
    currentRoom = "";
    sessionStorage.removeItem("imposteurRoom");
    isHost = false;
    hostToken = "";
    players = [];
    pendingRoomState = null;
    clearInterval(timerInterval);
    $("game").hidden = true;
    $("login").hidden = false;
    gameIsOpen = false;
    playersRenderKey = "";
    settingsRenderKey = "";
    wheelRenderKey = "";
    history.replaceState(null, "", "/");
    if (message) showToast(message);
}

function modeLabel(mode) {
    return ({ classic: "Classique", duo: "Duo", clue: "Indice", blind: "Aveugle", fast: "Rapide", chaos: "Chaos", custom: "Personnalisé" })[mode] || mode;
}

function displaySettings() {
    if (!roomSettings || !Object.keys(roomSettings).length) return;
    const nextKey = JSON.stringify([roomSettings.mode, roomSettings.categories, roomSettings.difficulties, roomSettings.time]);
    if (nextKey === settingsRenderKey) return;
    settingsRenderKey = nextKey;
    const categoryNames = {
        anime: "Anime & novels", games: "Jeux vidéo", movie: "Films", series: "Séries",
        marvel: "Marvel", dc: "DC Comics", cartoon: "Cartoons", sport: "Sport",
        music: "Musique", internet: "Internet", food: "Nourriture", timmy: "Timmy", Tout: "Toutes"
    };
    const difficultyNames = { easy: "Facile", normal: "Normal", hard: "Difficile", demon: "Démon" };
    $("settingsDisplay").innerHTML = `
        <span>${escapeHtml(modeLabel(roomSettings.mode))}</span>
        <span>${roomSettings.mode === "custom" ? "Sujets personnalisés" : escapeHtml((roomSettings.categories || []).map((value) => categoryNames[value] || value).join(" · "))}</span>
        <span>${escapeHtml((roomSettings.difficulties || []).map((value) => difficultyNames[value] || value).join(" · "))}</span>
        <span>${roomSettings.time || 30}s par joueur</span>`;
}

function copyText(text, successMessage) {
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast(successMessage)).catch(() => fallbackCopy(text, successMessage));
    } else fallbackCopy(text, successMessage);
}

function fallbackCopy(text, successMessage) {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    try { document.execCommand("copy"); } catch {}
    input.remove();
    showToast(successMessage);
}

function copyRoom() {
    copyText(currentRoom, `Code ${currentRoom} copié.`);
    playSound("click");
}

function inviteLink() {
    return `${location.origin}/?room=${encodeURIComponent(currentRoom)}`;
}

function copyInviteLink() {
    copyText(inviteLink(), "Lien d’invitation copié.");
    playSound("click");
}

function openQrCode() {
    const link = inviteLink();
    $("qrImage").src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=12&data=${encodeURIComponent(link)}`;
    $("qrLink").textContent = link;
    $("qrOverlay").hidden = false;
}

function closeQrCode() {
    $("qrOverlay").hidden = true;
    $("qrImage").removeAttribute("src");
}

function startGame() {
    if (!isHost) return;
    playSound("launch");
    playCinematic({ icon: "3", eyebrow: "PRÉPAREZ-VOUS", title: "La partie commence", text: "Les cartes vont être distribuées.", duration: 1500 });
    $("startButton").disabled = true;
    socket.emit("startGame", currentRoom);
}

function newRound() {
    if (!isHost) return;
    playSound("launch");
    $("newRound").disabled = true;
    socket.emit("newGame", currentRoom);
}

function returnLobby() {
    if (!isHost) return;
    socket.emit("returnLobby", currentRoom);
}

function showStage(stageId) {
    for (const id of ["waitingStage", "loadingStage", "cardStage", "turnPanel", "resultPanel"]) {
        $(id).hidden = id !== stageId;
    }
}

function resetCard() {
    clearTimeout(cardHideTimeout);
    myCard = null;
    cardRevealed = false;
    const card = $("card");
    card.hidden = false;
    card.disabled = false;
    card.classList.remove("is-flipped", "card-vanish");
    const image = $("characterImage");
    image.hidden = true;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    $("imageFallback").textContent = "?";
    $("imageLoading").hidden = true;
    $("subjectName").textContent = "...";
    $("subjectUniverse").textContent = "...";
    $("subjectCategory").textContent = "SUJET";
    $("subjectClue").hidden = true;
    $("subjectClue").textContent = "";
    $("cardHint").textContent = "La carte ne pourra être consultée qu’une seule fois.";
}

function categoryLabel(category) {
    const labels = {
        anime: "ANIME & NOVELS", games: "JEUX VIDÉO", movie: "FILM", series: "SÉRIE",
        marvel: "MARVEL", dc: "DC COMICS", cartoon: "CARTOON", sport: "SPORT",
        music: "MUSIQUE", internet: "INTERNET", food: "NOURRITURE", timmy: "TIMMY",
        custom: "PERSONNALISÉ", blind: "IMPOSTEUR"
    };
    return labels[category] || "SUJET";
}

function revealCard() {
    if (!myCard || cardRevealed) return;
    cardRevealed = true;
    sessionStorage.setItem(`imposteurRevealed:${currentRoom}:${currentRound}`, "1");
    playSound("reveal");
    vibrate(35);

    const card = $("card");
    card.disabled = true;
    $("imageFallback").textContent = myCard.character
        .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
    $("subjectName").textContent = myCard.character;
    $("subjectUniverse").textContent = myCard.universe;
    $("subjectCategory").textContent = categoryLabel(myCard.category);
    if (myCard.clue) {
        $("subjectClue").textContent = `Indice : ${myCard.clue}`;
        $("subjectClue").hidden = false;
    }
    $("cardHint").textContent = `Mémorise ta carte : elle disparaît dans ${roomSettings.cardTime || 5} secondes.`;

    if (myCard.image) loadCardImage(myCard.image);
    else {
        $("imageLoading").hidden = true;
        $("characterImage").hidden = true;
    }

    requestAnimationFrame(() => card.classList.add("is-flipped"));
    cardHideTimeout = setTimeout(hideCard, (roomSettings.cardTime || 5) * 1000);
}

function loadCardImage(src) {
    const image = $("characterImage");
    const loading = $("imageLoading");
    loading.hidden = false;
    image.hidden = true;
    image.onload = () => {
        image.onload = null;
        image.onerror = null;
        loading.hidden = true;
        image.hidden = false;
    };
    image.onerror = () => {
        image.onload = null;
        image.onerror = null;
        loading.hidden = true;
        image.hidden = true;
        image.removeAttribute("src");
    };
    image.decoding = "async";
    image.src = src;
}

function hideCard() {
    const card = $("card");
    card.classList.add("card-vanish");
    setTimeout(() => {
        card.hidden = true;
        const image = $("characterImage");
        image.removeAttribute("src");
        image.hidden = true;
        $("imageLoading").hidden = true;
        $("cardHint").textContent = "Carte mémorisée. Prépare ton indice.";
    }, lowPowerMode ? 50 : 420);
}

function renderPlayers(force = false) {
    if (document.hidden) return;
    const nextKey = JSON.stringify(players.map((player) => [player.token, player.name, player.score, player.connected, player.isHost, player.token === currentSpeakerToken, isHost]));
    if (!force && nextKey === playersRenderKey) return;
    playersRenderKey = nextKey;
    $("playerCount").textContent = `${players.length} joueur${players.length > 1 ? "s" : ""}`;
    const fragment = document.createDocumentFragment();
    for (const player of players) {
        const li = document.createElement("li");
        li.className = `${player.connected ? "" : "is-offline"} ${player.token === currentSpeakerToken ? "is-speaking" : ""}`;
        const initials = player.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
        const actions = isHost && player.token !== playerToken
            ? `<span class="player-actions"><button data-player-action="host" data-token="${escapeHtml(player.token)}" title="Donner le rôle d’hôte">H</button><button data-player-action="kick" data-token="${escapeHtml(player.token)}" title="Expulser">×</button></span>`
            : "";
        li.innerHTML = `
            <span class="avatar">${escapeHtml(initials || "?")}</span>
            <span class="player-name">${escapeHtml(player.name)}</span>
            ${player.isHost ? '<span class="host-badge">HÔTE</span>' : ""}
            ${player.token === playerToken ? '<span class="you-badge">TOI</span>' : ""}
            ${!player.connected ? '<span class="offline-badge">HORS LIGNE</span>' : ""}
            <span class="score-badge">${Number(player.score) || 0}</span>
            ${actions}`;
        fragment.appendChild(li);
    }
    $("players").replaceChildren(fragment);
    refreshHostUi();
    renderSpeakerWheel();
}

function refreshHostUi() {
    $("startButton").hidden = !isHost || !["lobby", "result"].includes(currentPhase);
    $("hostPanel").hidden = !isHost;
    $("newRound").hidden = !isHost;
    $("returnLobbyButton").hidden = !isHost;
}

function renderSpeakerWheel(force = false) {
    const wheel = $("speakerWheel");
    if (!wheel || document.hidden) return;
    const active = players.filter((player) => player.connected);
    const nextKey = JSON.stringify([currentSpeakerToken, active.map((player) => [player.token, player.name])]);
    if (!force && nextKey === wheelRenderKey) return;
    wheelRenderKey = nextKey;
    wheel.style.setProperty("--count", Math.max(1, active.length));
    wheel.innerHTML = active.map((player, index) => {
        const initials = player.name.slice(0, 1).toUpperCase();
        const activeClass = player.token === currentSpeakerToken ? " active" : "";
        return `<span class="wheel-player${activeClass}" style="--i:${index}" title="${escapeHtml(player.name)}">${escapeHtml(initials)}</span>`;
    }).join("");
}

function startTimer(deadline, phase = currentPhase) {
    phaseDeadline = Number(deadline) || null;
    currentPhase = phase;
    restartTimerLoop();
    updateTimerDisplay();
}

function restartTimerLoop() {
    clearInterval(timerInterval);
    timerInterval = null;
    lastTimerSecond = null;
    if (!phaseDeadline || document.hidden) return;
    timerInterval = setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay() {
    if (!phaseDeadline) {
        $("timer").textContent = "--";
        $("timerProgress").style.strokeDashoffset = "0";
        return;
    }
    const remainingMs = Math.max(0, phaseDeadline - Date.now());
    const remaining = Math.ceil(remainingMs / 1000);
    if (remaining === lastTimerSecond) return;
    lastTimerSecond = remaining;
    $("timer").textContent = remaining > 99 ? `${Math.ceil(remaining / 60)}m` : `${remaining}`;

    const total = currentPhase === "vote" ? 45 : currentPhase === "cards" ? Math.max(7, (roomSettings.cardTime || 5) + 3) : (roomSettings.time || 30);
    const ratio = Math.max(0, Math.min(1, remainingMs / (total * 1000)));
    $("timerProgress").style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * (1 - ratio));
    $("timerWrap").classList.toggle("timer-danger", remaining <= 5 && remaining > 0);
    if (remainingMs <= 0) clearInterval(timerInterval);
}

function renderTurn(token, turnIndex, total, deadline) {
    currentSpeakerToken = token;
    if (document.hidden) {
        currentPhase = "discussion";
        phaseDeadline = Number(deadline) || null;
        return;
    }
    currentPhase = "discussion";
    const speaker = players.find((player) => player.token === token);
    showStage("turnPanel");
    $("phase").textContent = "Tour de parole";
    $("turnCounter").textContent = `JOUEUR ${turnIndex + 1} SUR ${total}`;
    $("currentSpeaker").textContent = speaker?.name || "Joueur";
    $("speakerAvatar").textContent = (speaker?.name || "?").slice(0, 1).toUpperCase();
    const myTurn = token === playerToken;
    $("speakerInstruction").textContent = myTurn ? "Donne ton indice sans révéler directement ton sujet." : "Écoute bien son indice et repère les incohérences.";
    $("finishTurnButton").hidden = !myTurn;
    $("finishTurnButton").disabled = false;
    $("finishTurnHint").hidden = !myTurn;
    playersRenderKey = "";
    renderPlayers(true);
    renderSpeakerWheel(true);
    startTimer(deadline, "discussion");
    playSound("turn");
    vibrate(myTurn ? [50, 30, 50] : 30);
    playCinematic({ icon: "●", eyebrow: "TOUR DE PAROLE", title: speaker?.name || "Joueur", text: myTurn ? "C’est à toi de donner un indice." : "Écoutez attentivement son indice.", duration: 1050, toneName: "active" });
}

function finishMyTurn() {
    if (currentSpeakerToken !== playerToken) return;
    $("finishTurnButton").disabled = true;
    socket.emit("finishTurn", currentRoom);
}

function renderVotePlayers(votePlayers) {
    if (document.hidden) return;
    selectedVoteId = null;
    $("voteButton").disabled = true;
    const grid = $("voteGrid");
    const fragment = document.createDocumentFragment();
    for (const player of votePlayers) {
        if (player.token === playerToken) continue;
        const button = document.createElement("button");
        button.className = "vote-player";
        button.type = "button";
        button.disabled = !player.connected;
        button.dataset.token = player.token;
        button.innerHTML = `<span>${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span><b>${escapeHtml(player.name)}</b><small>${player.connected ? "Sélectionner" : "Déconnecté"}</small>`;
        fragment.appendChild(button);
    }
    grid.replaceChildren(fragment);
}

function vote() {
    if (alreadyVoted || !selectedVoteId) return;
    alreadyVoted = true;
    $("voteButton").disabled = true;
    $("voteGrid").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    socket.emit("vote", { code: currentRoom, target: selectedVoteId });
    showToast("Vote enregistré.");
}

function skipVote() {
    if (alreadyVoted) return;
    alreadyVoted = true;
    $("voteButton").disabled = true;
    $("voteGrid").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    socket.emit("vote", { code: currentRoom, target: "skip" });
    showToast("Tu as choisi de ne désigner personne.");
}

function renderResult(result) {
    if (!result) return;
    currentPhase = "result";
    if (document.hidden) {
        pendingRoomState = { ...(pendingRoomState || {}), phase: "result", result };
        return;
    }
    phaseDeadline = null;
    clearInterval(timerInterval);
    currentSpeakerToken = null;
    $("voteOverlay").hidden = true;
    $("phase").textContent = "Résultat";
    $("timer").textContent = "FIN";
    $("timerProgress").style.strokeDashoffset = "0";
    $("timerWrap").classList.remove("timer-danger");
    showStage("resultPanel");

    const noElimination = !result.eliminated;
    if (noElimination) playSound("vote");
    else if (result.correct) playSound("success");
    else playSound("eliminate");
    vibrate(result.correct ? [60, 35, 60] : 80);

    playCinematic({
        icon: noElimination ? "=" : "×",
        eyebrow: "RÉSULTAT",
        title: noElimination ? "Personne n’est éliminé" : `${result.eliminated} est éliminé`,
        text: noElimination ? (result.tie ? "Les votes sont à égalité." : "La majorité a passé le vote.") : (result.correct ? "Bien joué : un imposteur a été trouvé." : "Mauvais choix : l’imposteur s’en sort."),
        duration: 1900,
        toneName: noElimination ? "default" : (result.correct ? "active" : "danger")
    });

    $("resultIcon").textContent = noElimination ? "=" : "×";
    $("resultPanel").classList.toggle("correct-result", Boolean(result.correct));
    $("resultPanel").classList.toggle("wrong-result", Boolean(result.eliminated && !result.correct));
    $("resultTitle").textContent = noElimination ? "Aucune élimination" : `${result.eliminated} a été désigné`;
    $("resultText").textContent = noElimination
        ? (result.tie ? "Égalité : personne ne quitte la manche." : "Le vote a été passé.")
        : (result.correct ? "Le groupe a démasqué un imposteur." : "Ce joueur n’était pas un imposteur.");

    $("roleReveal").innerHTML = `
        <article><small>SUJET PRINCIPAL</small><b>${escapeHtml(result.mainSubject)}</b><span>${escapeHtml(result.mainUniverse)}</span></article>
        <article><small>SUJET DES IMPOSTEURS</small><b>${escapeHtml(result.fakeSubject)}</b><span>${escapeHtml(result.fakeUniverse)}</span></article>
        <article class="impostor-reveal"><small>IMPOSTEUR${result.impostors?.length > 1 ? "S" : ""}</small><b>${escapeHtml((result.impostors || []).join(", ") || "Inconnu")}</b></article>`;

    $("voteDetails").innerHTML = `<h3>Détail des votes</h3><div>${(result.votes || []).length
        ? result.votes.map((item) => `<p><b>${escapeHtml(item.voterName)}</b><span>→</span><strong>${escapeHtml(item.targetName)}</strong></p>`).join("")
        : "<p>Aucun vote enregistré.</p>"}</div>`;

    $("roundPlayers").innerHTML = `<h3>Cartes et classement</h3><div>${(result.players || []).map((player, index) => `
        <article class="${player.isImpostor ? "was-impostor" : ""}">
            <span class="ranking">#${index + 1}</span>
            <div><b>${escapeHtml(player.name)}</b><small>${escapeHtml(player.card?.character || "?")} · ${escapeHtml(player.card?.universe || "")}</small></div>
            <strong>${Number(player.score) || 0} pt${Number(player.score) > 1 ? "s" : ""}</strong>
        </article>`).join("")}</div>`;

    $("newRound").disabled = false;
    refreshHostUi();
    updateStatsFromResult(result);
}

function sendChat() {
    const input = $("chatInput");
    const message = input.value.trim();
    if (!message || !currentRoom) return;
    socket.emit("chat", { code: currentRoom, message });
    input.value = "";
}

function appendMessage(item) {
    if (document.hidden) {
        pendingChatMessages.push(item);
        pendingChatMessages = pendingChatMessages.slice(-MAX_RENDERED_MESSAGES);
        return;
    }
    const box = $("messages");
    const systemPlaceholder = box.querySelector(".system-message");
    if (systemPlaceholder) systemPlaceholder.remove();
    const stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    box.appendChild(createMessageElement(item));
    while (box.children.length > MAX_RENDERED_MESSAGES) box.firstElementChild?.remove();
    if (stickToBottom) box.scrollTop = box.scrollHeight;
}

function renderMessages(messages) {
    if (document.hidden) {
        pendingChatMessages = Array.isArray(messages) ? messages.slice(-MAX_RENDERED_MESSAGES) : [];
        return;
    }
    const box = $("messages");
    const fragment = document.createDocumentFragment();
    const items = Array.isArray(messages) ? messages.slice(-MAX_RENDERED_MESSAGES) : [];
    if (!items.length) {
        const p = document.createElement("p");
        p.className = "system-message";
        p.textContent = "Les messages de la room apparaîtront ici.";
        fragment.appendChild(p);
    } else {
        for (const item of items) fragment.appendChild(createMessageElement(item));
    }
    box.replaceChildren(fragment);
    box.scrollTop = box.scrollHeight;
}

function createMessageElement(item) {
    const p = document.createElement("p");
    if (item?.system) {
        p.className = "system-chat";
        p.textContent = item.message || "";
    } else {
        const name = document.createElement("b");
        const message = document.createElement("span");
        name.textContent = item?.name || "Joueur";
        message.textContent = item?.message || "";
        p.append(name, message);
    }
    return p;
}

function flushPendingChat() {
    if (!pendingChatMessages.length) return;
    const messages = pendingChatMessages;
    pendingChatMessages = [];
    renderMessages(messages);
}

function addTime(seconds) {
    if (!isHost) return;
    socket.emit("addTime", { code: currentRoom, seconds });
}

function hostNextPhase() {
    if (!isHost) return;
    socket.emit("hostNextPhase", currentRoom);
}

function updateRoomModeFields() {
    const custom = $("roomMode").value === "custom";
    $("roomCustomBlock").hidden = !custom;
    for (const control of document.querySelectorAll(".room-category, .room-difficulty, #roomLinkedMix")) {
        control.disabled = custom;
    }
}

function openSettingsModal() {
    if (!isHost) return;
    $("roomMode").value = roomSettings.mode || "classic";
    $("roomTime").value = String(roomSettings.time || 30);
    $("roomCardTime").value = String(roomSettings.cardTime || 5);
    $("roomImpostors").value = String(roomSettings.impostors || 1);
    $("roomLinkedMix").checked = Boolean(roomSettings.linkedMix);
    $("roomCustomSubjects").value = roomSettings.customSubjectsText || "";

    const categories = new Set(roomSettings.categories || ["anime"]);
    for (const input of document.querySelectorAll(".room-category")) {
        input.checked = categories.has("Tout") || categories.has(input.value);
    }
    const difficulties = new Set(roomSettings.difficulties || ["easy"]);
    for (const input of document.querySelectorAll(".room-difficulty")) {
        input.checked = difficulties.has(input.value);
    }

    updateRoomModeFields();
    $("settingsOverlay").hidden = false;
}

function closeSettingsModal() {
    $("settingsOverlay").hidden = true;
}

function saveRoomSettings() {
    const categories = [...document.querySelectorAll(".room-category:checked")].map((input) => input.value);
    const difficulties = [...document.querySelectorAll(".room-difficulty:checked")].map((input) => input.value);
    const mode = $("roomMode").value;
    const customSubjects = $("roomCustomSubjects").value.trim();

    if (mode !== "custom" && !categories.length) return showToast("Choisis au moins une catégorie.");
    if (mode !== "custom" && !difficulties.length) return showToast("Choisis au moins une difficulté.");
    if (mode === "custom" && customSubjects.split(/\r?\n/).filter((line) => line.trim()).length < 2) {
        return showToast("Ajoute au moins deux sujets personnalisés.");
    }

    const settings = {
        categories: categories.length === document.querySelectorAll(".room-category").length ? ["Tout"] : categories,
        difficulties,
        linkedMix: $("roomLinkedMix").checked,
        mode,
        time: Number($("roomTime").value),
        cardTime: Number($("roomCardTime").value),
        impostors: Number($("roomImpostors").value),
        customSubjects
    };
    socket.emit("updateSettings", { code: currentRoom, settings });
    closeSettingsModal();
}

function leaveRoom() {
    openConfirm("Quitter la room ?", "Ta place sera libérée et tu retourneras à l’accueil.", () => {
        socket.emit("leaveRoom", currentRoom);
        resetToLogin("Tu as quitté la room.");
    });
}

function openConfirm(title, text, callback) {
    confirmCallback = callback;
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmOverlay").hidden = false;
    $("confirmAction").onclick = () => {
        const action = confirmCallback;
        closeConfirm();
        action?.();
    };
}

function closeConfirm() {
    confirmCallback = null;
    $("confirmOverlay").hidden = true;
}

function updateStatsFromResult(result) {
    const processedKey = `imposteurStatsProcessed:${currentRoom}:${currentRound}`;
    if (sessionStorage.getItem(processedKey) === "1") return;
    const me = result.players?.find((player) => player.token === playerToken);
    if (!me) return;
    sessionStorage.setItem(processedKey, "1");
    const stats = JSON.parse(localStorage.getItem("imposteurLocalStats") || "{}") || {};
    stats.rounds = (stats.rounds || 0) + 1;
    const won = (result.correct && !me.isImpostor) || (!result.correct && me.isImpostor);
    if (won) stats.wins = (stats.wins || 0) + 1;
    if (me.isImpostor) stats.impostorRounds = (stats.impostorRounds || 0) + 1;
    localStorage.setItem("imposteurLocalStats", JSON.stringify(stats));
    updateLocalStats();
}

function updateLocalStats() {
    const stats = JSON.parse(localStorage.getItem("imposteurLocalStats") || "{}") || {};
    $("localStats").textContent = `${stats.rounds || 0} partie${(stats.rounds || 0) > 1 ? "s" : ""} · ${stats.wins || 0} victoire${(stats.wins || 0) > 1 ? "s" : ""} · ${stats.impostorRounds || 0} fois imposteur`;
}

function applyRoomState(state) {
    if (!state) return;
    pendingRoomState = state;
    currentRound = Number(state.round) || 0;
    currentPhase = state.phase || "lobby";
    roomSettings = state.settings || roomSettings;
    isHost = Boolean(state.isHost);
    hostToken = state.hostToken || hostToken;
    if (document.hidden) return;
    $("round").textContent = String(currentRound);
    displaySettings();
    refreshHostUi();
    renderMessages(state.messages || []);

    if (state.card) {
        myCard = state.card;
        cardRevealed = sessionStorage.getItem(`imposteurRevealed:${currentRoom}:${currentRound}`) === "1";
    }

    if (state.phase === "lobby") {
        phaseDeadline = null;
        $("phase").textContent = "En attente";
        showStage("waitingStage");
        $("startButton").disabled = false;
        startTimer(null, "lobby");
    } else if (state.phase === "cards") {
        $("phase").textContent = "Découverte des cartes";
        showStage("cardStage");
        if (!state.card) showStage("loadingStage");
        else if (cardRevealed) {
            $("card").hidden = true;
            $("cardHint").textContent = "Carte déjà consultée. Prépare ton indice.";
        }
        startTimer(state.phaseEndsAt, "cards");
    } else if (state.phase === "discussion") {
        renderTurn(state.currentSpeakerToken, state.turnIndex || 0, state.turnTotal || players.length, state.phaseEndsAt);
    } else if (state.phase === "vote") {
        alreadyVoted = false;
        $("phase").textContent = "Vote";
        renderVotePlayers(players.filter((player) => player.connected));
        $("voteProgress").textContent = `${state.voteProgress?.voted || 0} vote(s) sur ${state.voteProgress?.total || 0}`;
        $("voteOverlay").hidden = false;
        startTimer(state.phaseEndsAt, "vote");
    } else if (state.phase === "result") {
        renderResult(state.result);
    }
}

socket.on("identity", ({ playerToken: serverToken }) => {
    if (serverToken && serverToken !== playerToken) {
        playerToken = serverToken;
        sessionStorage.setItem("imposteurPlayerToken", playerToken);
    }
});

socket.on("connect", () => {
    clearTimeout(reconnectRequestTimer);
    reconnectRequestTimer = setTimeout(() => {
        if (!tabTokenConflictHandled && currentRoom && username && socket.connected) {
            socket.emit("reconnectRoom", { code: currentRoom, name: username });
        }
    }, 250);
});

socket.on("roomCreated", ({ code, settings, isHost: host }) => {
    currentRoom = code;
    roomSettings = settings;
    isHost = Boolean(host);
    sessionStorage.setItem("imposteurRoom", currentRoom);
    openGame();
    showToast(`Room ${code} créée.`);
});

socket.on("joined", ({ code, settings, isHost: host, reconnected }) => {
    currentRoom = code;
    roomSettings = settings;
    isHost = Boolean(host);
    sessionStorage.setItem("imposteurRoom", currentRoom);
    openGame();
    if (!reconnected) showToast(`Tu as rejoint la room ${code}.`);
});

socket.on("roomState", (state) => {
    pendingRoomState = state;
    if (document.hidden) return;
    openGame();
    applyRoomState(state);
});

socket.on("players", (list) => {
    players = Array.isArray(list) ? list : [];
    const me = players.find((player) => player.token === playerToken);
    isHost = Boolean(me?.isHost || hostToken === playerToken);
    const host = players.find((player) => player.isHost);
    if (host) hostToken = host.token;
    if (document.hidden) return;
    renderPlayers();
    if (pendingRoomState?.phase === "discussion") {
        renderTurn(pendingRoomState.currentSpeakerToken, pendingRoomState.turnIndex || 0, pendingRoomState.turnTotal || players.length, pendingRoomState.phaseEndsAt);
    } else if (pendingRoomState?.phase === "vote") {
        renderVotePlayers(players.filter((player) => player.connected));
        $("voteOverlay").hidden = false;
    }
});

socket.on("roundStarted", ({ round, phaseEndsAt }) => {
    currentRound = Number(round) || currentRound + 1;
    $("round").textContent = String(currentRound);
    currentPhase = "cards";
    currentSpeakerToken = null;
    alreadyVoted = false;
    selectedVoteId = null;
    if (document.hidden) {
        phaseDeadline = Number(phaseEndsAt) || null;
        return;
    }
    resetCard();
    showStage("loadingStage");
    $("phase").textContent = "Distribution";
    $("startButton").disabled = false;
    startTimer(phaseEndsAt, "cards");
});

socket.on("card", (card) => {
    myCard = card;
    cardRevealed = false;
    if (document.hidden) return;
    showStage("cardStage");
    $("phase").textContent = "Découvre ta carte";
});

socket.on("cardImage", ({ image } = {}) => {
    if (!myCard || !image) return;
    myCard.image = image;
    if (!document.hidden && cardRevealed && !$("card").hidden && !$("characterImage").src) loadCardImage(image);
});

socket.on("turn", ({ token, turnIndex, total, phaseEndsAt }) => {
    pendingRoomState = null;
    renderTurn(token, turnIndex, total, phaseEndsAt);
});

socket.on("turnFinished", ({ playerName, reason }) => {
    if (!document.hidden && reason === "manual") showToast(`${playerName} a terminé son tour.`);
});

socket.on("votePhase", ({ players: votePlayers, phaseEndsAt }) => {
    pendingRoomState = null;
    currentPhase = "vote";
    currentSpeakerToken = null;
    alreadyVoted = false;
    selectedVoteId = null;
    if (document.hidden) {
        phaseDeadline = Number(phaseEndsAt) || null;
        return;
    }
    $("phase").textContent = "Vote";
    renderPlayers();
    renderVotePlayers(votePlayers || []);
    $("voteProgress").textContent = "En attente des votes…";
    $("voteOverlay").hidden = false;
    startTimer(phaseEndsAt, "vote");
    playSound("vote");
    vibrate([50, 25, 50]);
    playCinematic({ icon: "V", eyebrow: "PHASE FINALE", title: "Place au vote", text: "Choisis la personne qui te semble la plus suspecte.", duration: 1200, toneName: "vote" });
});

socket.on("voteProgress", ({ voted, total }) => {
    if (!document.hidden) $("voteProgress").textContent = `${voted} vote${voted > 1 ? "s" : ""} sur ${total}`;
});

socket.on("voteResult", (result) => {
    pendingRoomState = null;
    renderResult(result);
});

socket.on("chat", appendMessage);

socket.on("timeAdded", ({ phaseEndsAt, seconds }) => {
    phaseDeadline = Number(phaseEndsAt) || null;
    if (document.hidden) return;
    startTimer(phaseEndsAt, currentPhase);
    showToast(`${seconds} secondes ajoutées.`);
});

socket.on("settingsUpdated", (settings) => {
    roomSettings = settings;
    settingsRenderKey = "";
    if (document.hidden) return;
    displaySettings();
    showToast("Réglages mis à jour.");
});

socket.on("hostChanged", ({ hostToken: token }) => {
    hostToken = token;
    isHost = token === playerToken;
    if (document.hidden) return;
    refreshHostUi();
    showToast(isHost ? "Tu es maintenant l’hôte." : "L’hôte de la room a changé.");
});

socket.on("returnedToLobby", () => {
    currentPhase = "lobby";
    phaseDeadline = null;
    currentSpeakerToken = null;
    myCard = null;
    if (document.hidden) return;
    resetCard();
    $("voteOverlay").hidden = true;
    $("phase").textContent = "En attente";
    showStage("waitingStage");
    $("startButton").disabled = false;
    refreshHostUi();
});

socket.on("playerKicked", ({ name }) => showToast(`${name} a été expulsé.`));
socket.on("kicked", ({ reason }) => resetToLogin(reason || "Tu as été expulsé."));
socket.on("roomExpired", () => resetToLogin("La room a expiré."));
socket.on("reconnectFailed", () => resetToLogin("La room n’existe plus ou ta place a expiré."));

socket.on("sessionReplaced", () => {
    if (tabTokenConflictHandled) return;
    tabTokenConflictHandled = true;
    const roomToJoin = currentRoom;
    playerToken = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");
    sessionStorage.setItem("imposteurPlayerToken", playerToken);
    sessionStorage.removeItem("imposteurRoom");
    socket.auth = { playerToken };
    socket.disconnect();
    location.replace(roomToJoin ? `/?room=${encodeURIComponent(roomToJoin)}` : "/");
});

socket.on("gameError", (message) => {
    $("startButton").disabled = false;
    $("newRound").disabled = false;
    showToast(message || "Une erreur est survenue.");
});

socket.on("disconnect", () => {
    if (currentRoom) showToast("Connexion perdue. Reconnexion automatique…");
});

Object.assign(window, {
    createRoom, joinRoom, copyRoom, copyInviteLink, openQrCode, closeQrCode,
    startGame, newRound, returnLobby, revealCard, finishMyTurn,
    vote, skipVote, sendChat, addTime, hostNextPhase,
    openSettingsModal, closeSettingsModal, saveRoomSettings,
    leaveRoom, closeConfirm
});
