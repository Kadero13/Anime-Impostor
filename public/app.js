const socket = io();

let currentRoom = "";
let username = localStorage.getItem("imposteurName") || "";
let isHost = false;
let roomSettings = {};
let myCard = null;
let cardRevealed = false;
let alreadyVoted = false;
let timerInterval = null;
let cardHideTimeout = null;

const $ = (id) => document.getElementById(id);

window.addEventListener("load", () => {
    if (username) $("username").value = username;
    bindCategoryControls();
    $("chatInput").addEventListener("keydown", (event) => {
        if (event.key === "Enter") sendChat();
    });
});

function bindCategoryControls() {
    $("toggleAllCategories").addEventListener("click", () => {
        const boxes = [...document.querySelectorAll(".category")];
        const shouldCheck = boxes.some((box) => !box.checked);
        boxes.forEach((box) => { box.checked = shouldCheck; });
        $("toggleAllCategories").textContent = shouldCheck ? "Tout désélectionner" : "Tout sélectionner";
    });
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
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 2800);
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
    socket.emit("joinRoom", { name: username, code });
}

function openGame() {
    $("login").hidden = true;
    $("game").hidden = false;
    $("roomCodeDisplay").textContent = currentRoom;
    $("startButton").hidden = !isHost;
    displaySettings();
}

function displaySettings() {
    const categoryNames = {
        anime: "Anime & novels",
        games: "Jeux vidéo",
        movie: "Films",
        series: "Séries",
        marvel: "Marvel",
        sport: "Sport",
        Tout: "Toutes"
    };
    const difficultyNames = { easy: "Facile", normal: "Normal", hard: "Difficile", demon: "Démon" };

    $("settingsDisplay").innerHTML = `
        <span>${roomSettings.categories.map((value) => categoryNames[value] || value).join(" · ")}</span>
        <span>${roomSettings.difficulties.map((value) => difficultyNames[value] || value).join(" · ")}</span>
        <span>${roomSettings.linkedMix ? "Mix lié activé" : "Même univers"}</span>
        <span>${roomSettings.time}s / joueur</span>
    `;
}

function copyRoom() {
    navigator.clipboard.writeText(currentRoom)
        .then(() => showToast(`Code ${currentRoom} copié.`))
        .catch(() => showToast(`Code : ${currentRoom}`));
}

function startGame() {
    socket.emit("startGame", currentRoom);
}

function newRound() {
    $("newRound").hidden = true;
    $("result").hidden = true;
    socket.emit("newGame", currentRoom);
}

function resetCard() {
    clearTimeout(cardHideTimeout);
    myCard = null;
    cardRevealed = false;
    $("characterImage").hidden = true;
    $("characterImage").removeAttribute("src");
    $("cardStage").classList.remove("has-image");
    $("card").hidden = false;
    $("card").disabled = false;
    $("card").className = "subject-card";
    $("cardText").textContent = "Clique pour révéler ta carte";
    $("card").querySelector("small").textContent = "Elle ne sera visible qu’une fois";
}

function revealCard() {
    if (!myCard || cardRevealed) return;
    cardRevealed = true;
    $("card").disabled = true;
    $("card").classList.add("revealed");
    $("cardText").innerHTML = `<b>${escapeHtml(myCard.character)}</b><span>${escapeHtml(myCard.universe)}</span>`;
    $("card").querySelector("small").textContent = `Disparaît dans ${roomSettings.cardTime || 5} secondes`;

    if (myCard.image) {
        const image = $("characterImage");
        image.hidden = true;
        image.referrerPolicy = "no-referrer";
        image.onload = () => {
            image.hidden = false;
            $("cardStage").classList.add("has-image");
        };
        image.onerror = () => {
            image.hidden = true;
            image.removeAttribute("src");
            $("cardStage").classList.remove("has-image");
        };
        image.src = myCard.image;
    }

    cardHideTimeout = setTimeout(() => {
        myCard = null;
        $("card").hidden = true;
        $("characterImage").hidden = true;
        $("characterImage").removeAttribute("src");
        $("cardStage").classList.remove("has-image");
    }, (roomSettings.cardTime || 5) * 1000);
}

function startLocalTimer(seconds, prefix = "") {
    clearInterval(timerInterval);
    let remaining = Number(seconds) || 0;

    const render = () => {
        $("timer").textContent = prefix ? `${prefix} ${remaining}s` : `${remaining}s`;
        if (remaining <= 0) {
            clearInterval(timerInterval);
            return;
        }
        remaining -= 1;
    };

    render();
    timerInterval = setInterval(render, 1000);
}

function sendChat() {
    const message = $("chatInput").value.trim();
    if (!message) return;
    socket.emit("chat", { code: currentRoom, message });
    $("chatInput").value = "";
}

function vote() {
    if (alreadyVoted) return showToast("Tu as déjà voté.");
    const target = $("voteList").value;
    if (!target) return showToast("Choisis un joueur.");
    socket.emit("vote", { code: currentRoom, target });
    lockVote();
}

function skipVote() {
    if (alreadyVoted) return;
    socket.emit("vote", { code: currentRoom, target: "skip" });
    lockVote();
}

function lockVote() {
    alreadyVoted = true;
    $("voteList").disabled = true;
    $("voteButton").disabled = true;
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
    $("voteList").innerHTML = "";

    players.forEach((player, index) => {
        const li = document.createElement("li");
        li.innerHTML = `
            <span class="avatar">${escapeHtml(player.name.charAt(0).toUpperCase())}</span>
            <span class="player-name">${escapeHtml(player.name)}</span>
            ${player.id === socket.id ? '<span class="you-badge">Toi</span>' : ""}
        `;
        $("players").appendChild(li);

        if (player.id !== socket.id) {
            const option = document.createElement("option");
            option.value = player.id;
            option.textContent = player.name;
            $("voteList").appendChild(option);
        }
    });
});

socket.on("card", (card) => {
    resetCard();
    myCard = card;
});

socket.on("cardPhase", ({ round, cardTime, preparationTime }) => {
    roomSettings.cardTime = cardTime;
    $("round").textContent = round;
    $("phase").textContent = "Découverte des cartes";
    $("turnPanel").hidden = true;
    $("result").hidden = true;
    $("newRound").hidden = true;
    $("voteOverlay").hidden = true;
    $("startButton").hidden = true;
    startLocalTimer(preparationTime, "Début dans");
});

socket.on("speakingTurn", ({ playerId, playerName, turnNumber, totalTurns, time }) => {
    $("phase").textContent = "Tour de discussion";
    $("card").hidden = true;
    $("characterImage").hidden = true;
    $("turnPanel").hidden = false;
    $("turnPanel").classList.toggle("my-turn", playerId === socket.id);
    $("turnCounter").textContent = `Tour ${turnNumber} sur ${totalTurns}`;
    $("currentSpeaker").textContent = playerName;
    $("speakerInstruction").textContent = playerId === socket.id
        ? "C’est à toi. Donne un indice sans révéler directement ton sujet."
        : `Écoute l’indice de ${playerName}.`;
    startLocalTimer(time);
});

socket.on("votePhase", ({ players }) => {
    clearInterval(timerInterval);
    alreadyVoted = false;
    $("phase").textContent = "Vote";
    $("timer").textContent = "";
    $("turnPanel").hidden = true;
    $("voteList").disabled = false;
    $("voteButton").disabled = false;
    $("voteProgress").textContent = "En attente des votes…";
    $("voteOverlay").hidden = false;
    $("voteList").innerHTML = "";

    players.filter((player) => player.id !== socket.id).forEach((player) => {
        const option = document.createElement("option");
        option.value = player.id;
        option.textContent = player.name;
        $("voteList").appendChild(option);
    });
});

socket.on("voteProgress", ({ voted, total }) => {
    $("voteProgress").textContent = `${voted} vote${voted > 1 ? "s" : ""} sur ${total}`;
});

socket.on("voteResult", ({ eliminated, tie }) => {
    $("voteOverlay").hidden = true;
    $("phase").textContent = "Résultat";
    $("result").hidden = false;
    $("result").textContent = eliminated
        ? `${eliminated} a été désigné.`
        : tie
            ? "Égalité : personne n’est éliminé."
            : "Personne n’est éliminé.";
    if (isHost) $("newRound").hidden = false;
});

socket.on("chat", ({ name, message }) => {
    const p = document.createElement("p");
    p.innerHTML = `<b>${escapeHtml(name)}</b><span>${escapeHtml(message)}</span>`;
    $("messages").appendChild(p);
    $("messages").scrollTop = $("messages").scrollHeight;
});

socket.on("gameError", showToast);
