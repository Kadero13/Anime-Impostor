const socket = io();

let currentRoom = "";
let username = localStorage.getItem("imposteurName") || "";
let isHost = false;
let roomSettings = {};
let myCard = null;
let cardRevealed = false;
let alreadyVoted = false;
let selectedVoteId = null;
let timerInterval = null;
let cardHideTimeout = null;
let soundEnabled = localStorage.getItem("imposteurSound") !== "off";
let audioContext = null;

const $ = (id) => document.getElementById(id);
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 20;

window.addEventListener("load", () => {
    if (username) $("username").value = username;
    bindControls();
    updateSoundButton();
});

function bindControls() {
    $("toggleAllCategories").addEventListener("click", () => {
        const boxes = [...document.querySelectorAll(".category")];
        const shouldCheck = boxes.some((box) => !box.checked);
        boxes.forEach((box) => { box.checked = shouldCheck; });
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
}

function updateSoundButton() {
    $("soundToggle").setAttribute("aria-pressed", String(soundEnabled));
    $("soundIcon").textContent = soundEnabled ? "♪" : "×";
    $("soundLabel").textContent = soundEnabled ? "Sons activés" : "Sons coupés";
}

function getAudioContext() {
    if (!soundEnabled) return null;
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    return audioContext;
}

function tone(frequency, start, duration, volume = 0.035, type = "sine") {
    const context = getAudioContext();
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, context.currentTime + start);
    gain.gain.setValueAtTime(0.0001, context.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(context.currentTime + start);
    oscillator.stop(context.currentTime + start + duration + 0.03);
}

function playSound(name) {
    if (!soundEnabled) return;
    const patterns = {
        click: [[460, 0, .08, .025, "sine"]],
        launch: [[220, 0, .18, .04, "sine"], [330, .12, .2, .04, "sine"], [520, .26, .28, .045, "triangle"]],
        reveal: [[300, 0, .12, .035, "triangle"], [620, .08, .22, .045, "sine"]],
        turn: [[420, 0, .1, .03, "sine"], [560, .11, .18, .035, "sine"]],
        vote: [[180, 0, .22, .04, "triangle"], [240, .18, .25, .04, "triangle"]],
        eliminate: [[310, 0, .12, .045, "sawtooth"], [220, .12, .18, .045, "sawtooth"], [120, .28, .35, .05, "sine"]],
        success: [[440, 0, .12, .035, "sine"], [660, .12, .16, .04, "sine"], [880, .25, .25, .04, "sine"]]
    };
    for (const values of patterns[name] || patterns.click) tone(...values);
}

function escapeHtml(value) {
    return String(value)
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
    void toast.offsetWidth;
    toast.classList.add("toast-in");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        toast.classList.add("toast-out");
        setTimeout(() => { toast.hidden = true; }, 260);
    }, 2600);
}

function playCinematic({ icon = "I", eyebrow = "", title = "", text = "", duration = 1450, toneName = "default" }) {
    const overlay = $("cinematicOverlay");
    $("cinematicIcon").textContent = icon;
    $("cinematicEyebrow").textContent = eyebrow;
    $("cinematicTitle").textContent = title;
    $("cinematicText").textContent = text;
    overlay.dataset.tone = toneName;
    overlay.hidden = false;
    overlay.classList.remove("cinematic-out");
    void overlay.offsetWidth;
    overlay.classList.add("cinematic-in");
    clearTimeout(playCinematic.timer);
    playCinematic.timer = setTimeout(() => {
        overlay.classList.add("cinematic-out");
        setTimeout(() => {
            overlay.hidden = true;
            overlay.classList.remove("cinematic-in", "cinematic-out");
        }, 420);
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

function createRoom() {
    saveName();
    const categories = getCategories();
    const difficulties = getDifficulties();
    if (!username) return showToast("Entre un pseudo.");
    if (!categories.length) return showToast("Choisis au moins une catégorie.");
    if (!difficulties.length) return showToast("Choisis au moins une difficulté.");

    playSound("click");
    socket.emit("createRoom", {
        name: username,
        categories,
        difficulties,
        linkedMix: $("linkedMix").checked,
        time: Number($("time").value),
        cardTime: Number($("cardTime").value),
        impostors: Number($("impostors").value)
    });
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
    $("login").hidden = true;
    $("game").hidden = false;
    $("roomCodeDisplay").textContent = currentRoom;
    $("startButton").hidden = !isHost;
    displaySettings();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function displaySettings() {
    const categoryNames = {
        anime: "Anime & novels", games: "Jeux vidéo", movie: "Films", series: "Séries",
        marvel: "Marvel", dc: "DC Comics", cartoon: "Cartoons", sport: "Sport",
        music: "Musique", internet: "Internet", food: "Nourriture", timmy: "Timmy", Tout: "Toutes"
    };
    const difficultyNames = { easy: "Facile", normal: "Normal", hard: "Difficile", demon: "Démon" };
    $("settingsDisplay").innerHTML = `
        <span>${roomSettings.categories.map((value) => categoryNames[value] || value).join(" · ")}</span>
        <span>${roomSettings.difficulties.map((value) => difficultyNames[value] || value).join(" · ")}</span>
        <span>${roomSettings.linkedMix ? "Mix lié" : "Même univers"}</span>
        <span>${roomSettings.time}s par joueur</span>`;
}

function copyRoom() {
    navigator.clipboard.writeText(currentRoom)
        .then(() => showToast(`Code ${currentRoom} copié.`))
        .catch(() => showToast(`Code : ${currentRoom}`));
    playSound("click");
}

function startGame() {
    playSound("launch");
    playCinematic({ icon: "3", eyebrow: "PRÉPAREZ-VOUS", title: "La partie commence", text: "Les cartes vont être distribuées.", duration: 1650 });
    $("startButton").disabled = true;
    socket.emit("startGame", currentRoom);
}

function newRound() {
    playSound("launch");
    $("newRound").hidden = true;
    socket.emit("newGame", currentRoom);
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
    $("characterImage").hidden = true;
    $("characterImage").removeAttribute("src");
    $("imageFallback").textContent = "?";
    $("imageLoading").hidden = true;
    $("subjectName").textContent = "...";
    $("subjectUniverse").textContent = "...";
    $("subjectCategory").textContent = "SUJET";
    $("cardHint").textContent = "La carte ne pourra être consultée qu’une seule fois.";
}

function categoryLabel(category) {
    const labels = {
        anime: "ANIME & NOVELS", games: "JEUX VIDÉO", movie: "FILM", series: "SÉRIE",
        marvel: "MARVEL", dc: "DC COMICS", cartoon: "CARTOON", sport: "SPORT",
        music: "MUSIQUE", internet: "INTERNET", food: "NOURRITURE", timmy: "TIMMY"
    };
    return labels[category] || "SUJET";
}

function testImageUrl(url, timeout = 4500) {
    return new Promise((resolve) => {
        if (!url) return resolve(null);
        const image = new Image();
        let finished = false;
        const done = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const timer = setTimeout(() => done(null), timeout);
        image.onload = () => done(url);
        image.onerror = () => done(null);
        image.referrerPolicy = "no-referrer";
        image.src = url;
    });
}

async function searchJikanInBrowser(card) {
    if (card.category !== "anime") return null;
    try {
        const response = await fetch(`https://api.jikan.moe/v4/characters?q=${encodeURIComponent(card.character)}&limit=5`);
        if (!response.ok) return null;
        const data = await response.json();
        const entry = data.data?.[0];
        return entry?.images?.jpg?.large_image_url || entry?.images?.jpg?.image_url || null;
    } catch {
        return null;
    }
}

async function searchWikipediaInBrowser(card, language) {
    const query = `${card.character} ${card.universe}`.trim();
    const params = new URLSearchParams({
        action: "query",
        format: "json",
        origin: "*",
        generator: "search",
        gsrsearch: query,
        gsrlimit: "6",
        gsrnamespace: "0",
        prop: "pageimages|pageprops",
        piprop: "thumbnail|original",
        pithumbsize: "800",
        redirects: "1"
    });
    try {
        const response = await fetch(`https://${language}.wikipedia.org/w/api.php?${params}`);
        if (!response.ok) return null;
        const data = await response.json();
        const pages = Object.values(data.query?.pages || {})
            .filter((page) => !page.pageprops?.disambiguation)
            .filter((page) => page.thumbnail?.source || page.original?.source)
            .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
        return pages[0]?.thumbnail?.source || pages[0]?.original?.source || null;
    } catch {
        return null;
    }
}

async function resolveCardImage(card) {
    for (const candidate of [card.image, card.remoteImage]) {
        const working = await testImageUrl(candidate);
        if (working) return working;
    }

    const jikan = await searchJikanInBrowser(card);
    if (await testImageUrl(jikan)) return jikan;

    for (const language of ["fr", "en"]) {
        const wikipedia = await searchWikipediaInBrowser(card, language);
        if (await testImageUrl(wikipedia)) return wikipedia;
    }
    return null;
}

function revealCard() {
    if (!myCard || cardRevealed) return;
    cardRevealed = true;
    playSound("reveal");

    const card = $("card");
    card.disabled = true;
    $("imageFallback").textContent = myCard.character
        .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
    $("subjectName").textContent = myCard.character;
    $("subjectUniverse").textContent = myCard.universe;
    $("subjectCategory").textContent = categoryLabel(myCard.category);
    $("cardHint").textContent = `Mémorise ta carte : elle disparaît dans ${roomSettings.cardTime || 5} secondes.`;

    const cardData = myCard;
    const image = $("characterImage");
    const loading = $("imageLoading");
    loading.hidden = false;
    image.hidden = true;
    image.classList.remove("image-ready");

    Promise.resolve(cardData._imagePromise || resolveCardImage(cardData)).then((source) => {
        if (!cardRevealed || card.hidden || myCard !== cardData) return;
        loading.hidden = true;
        if (!source) return;
        image.onload = () => {
            image.hidden = false;
            requestAnimationFrame(() => image.classList.add("image-ready"));
        };
        image.onerror = () => {
            image.hidden = true;
            image.removeAttribute("src");
        };
        image.referrerPolicy = "no-referrer";
        image.src = source;
    });

    requestAnimationFrame(() => card.classList.add("is-flipped"));
    cardHideTimeout = setTimeout(() => {
        card.classList.add("card-vanish");
        setTimeout(() => {
            myCard = null;
            card.hidden = true;
            $("cardHint").textContent = "Carte mémorisée. Prépare ton indice.";
        }, 520);
    }, (roomSettings.cardTime || 5) * 1000);
}

function startLocalTimer(seconds, prefix = "") {
    clearInterval(timerInterval);
    const total = Math.max(1, Number(seconds) || 1);
    let remaining = total;
    const progress = $("timerProgress");
    progress.style.strokeDasharray = String(TIMER_CIRCUMFERENCE);

    const render = () => {
        $("timer").textContent = prefix ? `${prefix} ${remaining}s` : `${remaining}s`;
        const ratio = Math.max(0, remaining / total);
        progress.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * (1 - ratio));
        $("timerWrap").classList.toggle("timer-danger", remaining <= 5);
        if (remaining <= 0) {
            clearInterval(timerInterval);
            return;
        }
        remaining -= 1;
    };

    render();
    timerInterval = setInterval(render, 1000);
}

function finishMyTurn() {
    const button = $("finishTurnButton");
    if (button.hidden || button.disabled) return;
    button.disabled = true;
    button.querySelector("span").textContent = "Tour terminé";
    playSound("click");
    socket.emit("finishTurn", currentRoom);
}

function sendChat() {
    const message = $("chatInput").value.trim();
    if (!message) return;
    socket.emit("chat", { code: currentRoom, message });
    $("chatInput").value = "";
}

function renderVotePlayers(players) {
    selectedVoteId = null;
    $("voteButton").disabled = true;
    $("voteGrid").innerHTML = "";

    players.filter((player) => player.id !== socket.id).forEach((player) => {
        const button = document.createElement("button");
        button.className = "vote-player";
        button.type = "button";
        button.dataset.playerId = player.id;
        button.innerHTML = `<span>${escapeHtml(player.name.charAt(0).toUpperCase())}</span><b>${escapeHtml(player.name)}</b><small>Choisir</small>`;
        button.addEventListener("click", () => {
            if (alreadyVoted) return;
            selectedVoteId = player.id;
            document.querySelectorAll(".vote-player").forEach((item) => item.classList.toggle("selected", item === button));
            $("voteButton").disabled = false;
            playSound("click");
        });
        $("voteGrid").appendChild(button);
    });
}

function vote() {
    if (alreadyVoted) return showToast("Tu as déjà voté.");
    if (!selectedVoteId) return showToast("Choisis un joueur.");
    playSound("vote");
    socket.emit("vote", { code: currentRoom, target: selectedVoteId });
    lockVote();
}

function skipVote() {
    if (alreadyVoted) return;
    playSound("vote");
    socket.emit("vote", { code: currentRoom, target: "skip" });
    lockVote();
}

function lockVote() {
    alreadyVoted = true;
    $("voteButton").disabled = true;
    document.querySelectorAll(".vote-player").forEach((item) => { item.disabled = true; });
    $("voteProgress").textContent = "Vote envoyé. En attente des autres joueurs…";
}

socket.on("roomCreated", ({ code, settings }) => {
    currentRoom = code;
    roomSettings = settings;
    isHost = true;
    openGame();
});

socket.on("joined", ({ code, settings }) => {
    currentRoom = code;
    roomSettings = settings;
    isHost = false;
    openGame();
});

socket.on("becameHost", () => {
    isHost = true;
    $("startButton").hidden = false;
    showToast("Tu es maintenant l’hôte.");
});

socket.on("players", (players) => {
    $("playerCount").textContent = `${players.length} joueur${players.length > 1 ? "s" : ""}`;
    $("players").innerHTML = "";
    players.forEach((player) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="avatar">${escapeHtml(player.name.charAt(0).toUpperCase())}</span><span class="player-name">${escapeHtml(player.name)}</span>${player.isHost ? '<span class="host-badge">Hôte</span>' : ""}${player.id === socket.id ? '<span class="you-badge">Toi</span>' : ""}<span class="score-badge">${player.score || 0}</span>`;
        $("players").appendChild(li);
    });
});

socket.on("roundStarting", ({ round }) => {
    $("round").textContent = round;
    $("phase").textContent = "Préparation";
    $("startButton").hidden = true;
    $("startButton").disabled = false;
    $("voteOverlay").hidden = true;
    showStage("loadingStage");
});

socket.on("card", (card) => {
    resetCard();
    card._imagePromise = resolveCardImage(card);
    myCard = card;
});

socket.on("cardPhase", ({ round, cardTime, preparationTime }) => {
    roomSettings.cardTime = cardTime;
    $("round").textContent = round;
    $("phase").textContent = "Découverte des cartes";
    showStage("cardStage");
    playCinematic({ icon: "?", eyebrow: `MANCHE ${round}`, title: "Découvre ta carte", text: "Clique dessus et mémorise bien ton sujet.", duration: 1450 });
    startLocalTimer(preparationTime, "Début dans");
});

socket.on("speakingTurn", ({ playerId, playerName, turnNumber, totalTurns, time }) => {
    const myTurn = playerId === socket.id;
    playSound("turn");
    playCinematic({
        icon: String(turnNumber),
        eyebrow: `TOUR ${turnNumber} SUR ${totalTurns}`,
        title: myTurn ? "C’est à toi de parler" : `${playerName} prend la parole`,
        text: myTurn ? "Donne ton indice, puis termine ton tour quand tu as fini." : "Écoute attentivement son indice.",
        duration: 1100,
        toneName: myTurn ? "active" : "default"
    });

    $("phase").textContent = "Tour de discussion";
    showStage("turnPanel");
    $("turnPanel").classList.toggle("my-turn", myTurn);
    $("turnCounter").textContent = `TOUR ${turnNumber} SUR ${totalTurns}`;
    $("currentSpeaker").textContent = playerName;
    $("speakerAvatar").textContent = playerName.charAt(0).toUpperCase();
    $("speakerInstruction").textContent = myTurn
        ? "Donne un indice sans révéler directement ton sujet. Appuie sur le bouton dès que tu as fini."
        : `Écoute l’indice de ${playerName}.`;

    const finishButton = $("finishTurnButton");
    finishButton.hidden = !myTurn;
    finishButton.disabled = false;
    finishButton.querySelector("span").textContent = "J’ai fini de parler";
    $("finishTurnHint").hidden = !myTurn;
    startLocalTimer(time);
});

socket.on("turnFinished", ({ playerName }) => {
    showToast(`${playerName} a terminé son tour.`);
});

socket.on("votePhase", ({ players }) => {
    clearInterval(timerInterval);
    alreadyVoted = false;
    $("phase").textContent = "Vote";
    $("timer").textContent = "VOTE";
    $("timerProgress").style.strokeDashoffset = "0";
    $("timerWrap").classList.remove("timer-danger");
    renderVotePlayers(players);
    $("voteProgress").textContent = "En attente des votes…";
    $("voteOverlay").hidden = false;
    playSound("vote");
    playCinematic({ icon: "V", eyebrow: "PHASE FINALE", title: "Place au vote", text: "Choisis la personne qui te semble la plus suspecte.", duration: 1400, toneName: "vote" });
});

socket.on("voteProgress", ({ voted, total }) => {
    $("voteProgress").textContent = `${voted} vote${voted > 1 ? "s" : ""} sur ${total}`;
});

socket.on("voteResult", ({ eliminated, tie, correct, mainSubject, mainUniverse, fakeSubject, fakeUniverse, impostors }) => {
    $("voteOverlay").hidden = true;
    $("phase").textContent = "Résultat";
    showStage("resultPanel");

    const noElimination = !eliminated;
    if (noElimination) playSound("vote");
    else if (correct) playSound("success");
    else playSound("eliminate");

    playCinematic({
        icon: noElimination ? "=" : "×",
        eyebrow: "RÉSULTAT",
        title: noElimination ? "Personne n’est éliminé" : `${eliminated} est éliminé`,
        text: noElimination ? (tie ? "Les votes sont à égalité." : "La majorité a choisi de ne désigner personne.") : (correct ? "Bien joué : un imposteur a été trouvé." : "Mauvais choix : l’imposteur s’en sort."),
        duration: 2400,
        toneName: noElimination ? "default" : (correct ? "active" : "danger")
    });

    $("resultIcon").textContent = noElimination ? "=" : "×";
    $("resultPanel").classList.toggle("correct-result", Boolean(correct));
    $("resultPanel").classList.toggle("wrong-result", Boolean(eliminated && !correct));
    $("resultTitle").textContent = noElimination ? "Aucune élimination" : `${eliminated} a été désigné`;
    $("resultText").textContent = noElimination
        ? (tie ? "Égalité : personne ne quitte la manche." : "Le vote a été passé.")
        : (correct ? "Le groupe a démasqué un imposteur." : "Ce joueur n’était pas un imposteur.");
    $("roleReveal").innerHTML = `
        <article><small>SUJET PRINCIPAL</small><b>${escapeHtml(mainSubject)}</b><span>${escapeHtml(mainUniverse)}</span></article>
        <article><small>SUJET DES IMPOSTEURS</small><b>${escapeHtml(fakeSubject)}</b><span>${escapeHtml(fakeUniverse)}</span></article>
        <article class="impostor-reveal"><small>IMPOSTEUR${impostors.length > 1 ? "S" : ""}</small><b>${escapeHtml(impostors.join(", ") || "Inconnu")}</b></article>`;
    $("newRound").hidden = !isHost;
});

socket.on("chat", ({ name, message }) => {
    const system = $("messages").querySelector(".system-message");
    if (system) system.remove();
    const p = document.createElement("p");
    p.innerHTML = `<b>${escapeHtml(name)}</b><span>${escapeHtml(message)}</span>`;
    $("messages").appendChild(p);
    $("messages").scrollTop = $("messages").scrollHeight;
});

socket.on("gameError", (message) => {
    $("startButton").disabled = false;
    if (isHost) $("startButton").hidden = false;
    showToast(message);
});
