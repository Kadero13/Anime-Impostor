const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const DATABASE_DIR = path.join(__dirname, "public", "database");
const rooms = {};
const imageSearchCache = new Map();
const imageRegistry = new Map();
const imageBinaryCache = new Map();
let database = [];
let availableCategories = [];

function loadDatabase() {
    database = [];
    const files = fs.readdirSync(DATABASE_DIR).filter((file) => file.endsWith(".json"));
    availableCategories = files.map((file) => file.replace(".json", ""));

    for (const file of files) {
        const category = file.replace(".json", "");
        const subjects = JSON.parse(fs.readFileSync(path.join(DATABASE_DIR, file), "utf8"));

        for (const subject of subjects) {
            if (!subject?.name || !subject?.universe) continue;
            database.push({
                ...subject,
                category,
                difficulty: subject.difficulty || "normal",
                tags: Array.isArray(subject.tags)
                    ? [...new Set(subject.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))]
                    : []
            });
        }
    }

    console.log(`✅ ${database.length} sujets chargés dans ${availableCategories.length} catégories`);
}

loadDatabase();

function safeRemoteImageUrl(value) {
    try {
        const url = new URL(value);
        const allowedHosts = new Set([
            "cdn.myanimelist.net",
            "images.myanimelist.net",
            "upload.wikimedia.org"
        ]);
        return url.protocol === "https:" && allowedHosts.has(url.hostname);
    } catch {
        return false;
    }
}

function registerRemoteImage(url) {
    if (!safeRemoteImageUrl(url)) return null;
    const token = crypto.createHash("sha1").update(url).digest("hex");
    imageRegistry.set(token, url);
    return `/api/image/${token}`;
}

app.get("/api/image/:token", async (req, res) => {
    const token = String(req.params.token || "");
    const remoteUrl = imageRegistry.get(token);
    if (!remoteUrl) return res.sendStatus(404);

    const cached = imageBinaryCache.get(token);
    if (cached) {
        res.set("Content-Type", cached.contentType);
        res.set("Cache-Control", "public, max-age=86400");
        return res.send(cached.data);
    }

    try {
        const response = await axios.get(remoteUrl, {
            responseType: "arraybuffer",
            timeout: 9000,
            maxContentLength: 8 * 1024 * 1024,
            headers: {
                "User-Agent": "Mozilla/5.0 Anime-Imposteur-V14",
                Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            }
        });

        const contentType = String(response.headers["content-type"] || "image/jpeg");
        if (!contentType.startsWith("image/")) return res.sendStatus(415);

        const data = Buffer.from(response.data);
        imageBinaryCache.set(token, { contentType, data });
        if (imageBinaryCache.size > 250) imageBinaryCache.delete(imageBinaryCache.keys().next().value);

        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=86400");
        return res.send(data);
    } catch (error) {
        console.warn("Image proxy indisponible:", error.message);
        return res.sendStatus(404);
    }
});

function buildImageQueries(subject) {
    const name = String(subject.name || "").trim();
    const universe = String(subject.universe || "").trim();
    const suffixes = {
        anime: "anime character",
        games: "video game character",
        movie: "film character",
        series: "TV character",
        marvel: "Marvel character",
        dc: "DC Comics character",
        cartoon: "cartoon character",
        sport: "athlete",
        music: "musician",
        internet: "content creator",
        food: "dish food"
    };

    return [
        `${name} ${universe}`,
        `${name} ${suffixes[subject.category] || "character"}`,
        name
    ].map((query) => query.trim()).filter((query, index, list) => query && list.indexOf(query) === index);
}

async function getJikanImage(subject) {
    if (subject.category !== "anime") return null;
    try {
        const response = await axios.get("https://api.jikan.moe/v4/characters", {
            params: { q: subject.name, limit: 5 },
            timeout: 4500,
            headers: { "User-Agent": "Anime-Imposteur-V14" }
        });
        const entries = response.data?.data || [];
        const searched = subject.name.toLowerCase();
        const exact = entries.find((entry) => {
            const names = [entry.name, entry.name_kanji, ...(entry.nicknames || [])]
                .filter(Boolean)
                .map((name) => String(name).toLowerCase());
            return names.some((name) => name === searched || name.includes(searched) || searched.includes(name));
        });
        const entry = exact || entries[0];
        return entry?.images?.jpg?.large_image_url || entry?.images?.jpg?.image_url || null;
    } catch {
        return null;
    }
}

async function searchWikipediaImage(subject, language) {
    for (const query of buildImageQueries(subject).slice(0, 2)) {
        try {
            const response = await axios.get(`https://${language}.wikipedia.org/w/api.php`, {
                params: {
                    action: "query",
                    format: "json",
                    origin: "*",
                    generator: "search",
                    gsrsearch: query,
                    gsrlimit: 8,
                    gsrnamespace: 0,
                    prop: "pageimages|pageprops",
                    piprop: "thumbnail|original",
                    pithumbsize: 800,
                    redirects: 1
                },
                timeout: 4500,
                headers: { "User-Agent": "Anime-Imposteur-V14 automatic image search" }
            });

            const pages = Object.values(response.data?.query?.pages || {})
                .filter((page) => !page.pageprops?.disambiguation)
                .filter((page) => page.thumbnail?.source || page.original?.source)
                .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

            const image = pages[0]?.thumbnail?.source || pages[0]?.original?.source;
            if (safeRemoteImageUrl(image)) return image;
        } catch {
            // Une autre requête ou langue sera essayée.
        }
    }
    return null;
}

async function getImage(subject) {
    if (!subject || subject.category === "timmy") return { image: null, remoteImage: null };
    if (subject.image && safeRemoteImageUrl(subject.image)) {
        return { image: registerRemoteImage(subject.image), remoteImage: subject.image };
    }

    const cacheKey = `${subject.category}|${subject.universe}|${subject.name}`.toLowerCase();
    if (imageSearchCache.has(cacheKey)) return imageSearchCache.get(cacheKey);

    const [jikanImage, frenchImage, englishImage] = await Promise.all([
        getJikanImage(subject),
        searchWikipediaImage(subject, "fr"),
        searchWikipediaImage(subject, "en")
    ]);
    const remoteImage = jikanImage || frenchImage || englishImage || null;

    const result = {
        image: remoteImage ? registerRemoteImage(remoteImage) : null,
        remoteImage: remoteImage || null
    };
    imageSearchCache.set(cacheKey, result);
    return result;
}

function normalizeSettings(data = {}) {
    const validCategories = new Set([...availableCategories, "Tout"]);
    const validDifficulties = new Set(["easy", "normal", "hard", "demon"]);

    let categories = Array.isArray(data.categories)
        ? [...new Set(data.categories.filter((category) => validCategories.has(category)))]
        : ["anime"];
    let difficulties = Array.isArray(data.difficulties)
        ? [...new Set(data.difficulties.filter((difficulty) => validDifficulties.has(difficulty)))]
        : ["easy"];

    if (categories.includes("Tout")) categories = ["Tout"];
    if (!categories.length) categories = ["anime"];
    if (!difficulties.length) difficulties = ["easy"];

    return {
        categories,
        difficulties,
        linkedMix: Boolean(data.linkedMix),
        time: Math.min(180, Math.max(8, Number(data.time) || 30)),
        cardTime: Math.min(20, Math.max(3, Number(data.cardTime) || 5)),
        impostors: Math.min(5, Math.max(1, Number(data.impostors) || 1))
    };
}

function getPool(room) {
    const selected = database.filter((subject) => {
        const categoryOk = room.settings.categories.includes("Tout") || room.settings.categories.includes(subject.category);
        const difficultyOk = room.settings.difficulties.includes(subject.difficulty);
        return categoryOk && difficultyOk;
    });
    return selected.length >= 2 ? selected : database;
}

function sharedTags(a, b) {
    const bTags = new Set(b.tags || []);
    return (a.tags || []).filter((tag) => bTags.has(tag));
}

function weightedChoice(entries, weightFn) {
    if (!entries.length) return null;
    const weighted = entries.map((entry) => ({ entry, weight: Math.max(1, weightFn(entry)) }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let cursor = Math.random() * total;
    for (const item of weighted) {
        cursor -= item.weight;
        if (cursor <= 0) return item.entry;
    }
    return weighted.at(-1).entry;
}

function choosePair(room) {
    const pool = getPool(room);
    const recentNames = new Set(room.recentSubjects.slice(-28));
    const freshPool = pool.filter((subject) => !recentNames.has(subject.name));
    const mainPool = freshPool.length >= 2 ? freshPool : pool;
    const main = mainPool[Math.floor(Math.random() * mainPool.length)];

    if (room.settings.linkedMix) {
        const mixed = pool
            .filter((candidate) => candidate.name !== main.name && candidate.universe !== main.universe)
            .map((candidate) => ({ candidate, links: sharedTags(main, candidate) }))
            .filter((entry) => entry.links.length >= 2);

        const selected = weightedChoice(mixed, (entry) => {
            const categoryBonus = entry.candidate.category !== main.category ? 2.2 : 1;
            const freshness = recentNames.has(entry.candidate.name) ? 0.35 : 1;
            return (entry.links.length ** 3) * categoryBonus * freshness;
        });

        if (selected) return { main, fake: selected.candidate, links: selected.links };
    }

    let candidates = pool.filter((candidate) =>
        candidate.name !== main.name &&
        candidate.universe === main.universe &&
        candidate.category === main.category
    );

    if (!candidates.length) {
        candidates = pool
            .filter((candidate) => candidate.name !== main.name)
            .map((candidate) => ({ candidate, links: sharedTags(main, candidate) }))
            .filter((entry) => entry.links.length >= 2)
            .sort((a, b) => b.links.length - a.links.length)
            .slice(0, 20)
            .map((entry) => entry.candidate);
    }

    const fake = candidates[Math.floor(Math.random() * candidates.length)] || main;
    return { main, fake, links: sharedTags(main, fake) };
}

function chooseImpostors(players, requestedCount) {
    const count = Math.min(Math.max(1, requestedCount), Math.max(1, players.length - 1));
    return [...players].sort(() => Math.random() - 0.5).slice(0, count).map((player) => player.id);
}

function createRoomCode() {
    let code;
    do code = Math.random().toString(36).slice(2, 8).toUpperCase(); while (rooms[code]);
    return code;
}

function publicPlayers(room) {
    return room.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        isHost: player.id === room.host
    }));
}

function sendPlayers(code) {
    const room = rooms[code];
    if (room) io.to(code).emit("players", publicPlayers(room));
}

function clearRoomTimers(room) {
    for (const timer of room.timers) clearTimeout(timer);
    room.timers = [];
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
}

function schedule(room, callback, delay) {
    const timer = setTimeout(callback, delay);
    room.timers.push(timer);
    return timer;
}

function beginVote(code) {
    const room = rooms[code];
    if (!room || !room.started) return;
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.currentSpeakerId = null;
    room.phase = "vote";
    room.votes = {};
    room.votedPlayers = [];
    io.to(code).emit("votePhase", { players: publicPlayers(room) });
}

function launchCurrentTurn(code) {
    const room = rooms[code];
    if (!room || room.phase !== "discussion") return;

    while (
        room.currentTurnIndex < room.turnOrder.length &&
        !room.players.some((player) => player.id === room.turnOrder[room.currentTurnIndex].id)
    ) {
        room.currentTurnIndex += 1;
    }

    if (room.currentTurnIndex >= room.turnOrder.length) {
        beginVote(code);
        return;
    }

    const player = room.turnOrder[room.currentTurnIndex];
    room.currentSpeakerId = player.id;
    io.to(code).emit("speakingTurn", {
        playerId: player.id,
        playerName: player.name,
        turnNumber: room.currentTurnIndex + 1,
        totalTurns: room.turnOrder.length,
        time: room.settings.time
    });

    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = setTimeout(() => advanceTurn(code, player.id), room.settings.time * 1000);
}

function advanceTurn(code, expectedSpeakerId = null) {
    const room = rooms[code];
    if (!room || room.phase !== "discussion") return;
    if (expectedSpeakerId && room.currentSpeakerId !== expectedSpeakerId) return;
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.currentSpeakerId = null;
    room.currentTurnIndex += 1;
    launchCurrentTurn(code);
}

function beginSpeakingTurns(code) {
    const room = rooms[code];
    if (!room || !room.started || !room.players.length) return;
    room.phase = "discussion";
    room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
    room.currentTurnIndex = 0;
    launchCurrentTurn(code);
}

async function startRound(code, socketId) {
    const room = rooms[code];
    if (!room) return;
    if (room.host !== socketId) return io.to(socketId).emit("gameError", "Seul l’hôte peut lancer la manche.");
    if (room.players.length < 3) return io.to(socketId).emit("gameError", "Il faut au moins 3 joueurs.");

    clearRoomTimers(room);
    room.started = true;
    room.phase = "loading";
    room.votes = {};
    room.votedPlayers = [];
    room.round += 1;
    io.to(code).emit("roundStarting", { round: room.round });

    const { main, fake, links } = choosePair(room);
    const impostorIds = chooseImpostors(room.players, room.settings.impostors);
    room.roundData = { main, fake, impostorIds, links };
    room.recentSubjects.push(main.name, fake.name);
    if (room.recentSubjects.length > 60) room.recentSubjects.splice(0, room.recentSubjects.length - 60);

    const [mainImageData, fakeImageData] = await Promise.all([getImage(main), getImage(fake)]);
    if (!rooms[code] || rooms[code] !== room) return;

    for (const player of room.players) {
        const isImpostor = impostorIds.includes(player.id);
        const subject = isImpostor ? fake : main;
        const imageData = isImpostor ? fakeImageData : mainImageData;
        io.to(player.id).emit("card", {
            character: subject.name,
            universe: subject.universe,
            category: subject.category,
            image: imageData.image,
            remoteImage: imageData.remoteImage
        });
    }

    room.phase = "cards";
    const preparationTime = Math.max(13, room.settings.cardTime + 8);
    io.to(code).emit("cardPhase", {
        round: room.round,
        cardTime: room.settings.cardTime,
        preparationTime
    });
    console.log(`[${code}] ${main.name} VS ${fake.name} | liens: ${links.join(", ") || "même univers"}`);
    schedule(room, () => beginSpeakingTurns(code), preparationTime * 1000);
}

io.on("connection", (socket) => {
    socket.on("createRoom", (data) => {
        const name = String(data?.name || "").trim().slice(0, 18);
        if (!name) return socket.emit("gameError", "Entre un pseudo.");

        const code = createRoomCode();
        const settings = normalizeSettings(data);
        rooms[code] = {
            host: socket.id,
            players: [{ id: socket.id, name, score: 0 }],
            settings,
            round: 0,
            votes: {},
            votedPlayers: [],
            started: false,
            phase: "lobby",
            timers: [],
            turnTimer: null,
            currentSpeakerId: null,
            recentSubjects: [],
            roundData: null
        };

        socket.join(code);
        socket.emit("roomCreated", { code, settings });
        sendPlayers(code);
    });

    socket.on("joinRoom", (data) => {
        const code = String(data?.code || "").trim().toUpperCase();
        const name = String(data?.name || "").trim().slice(0, 18);
        const room = rooms[code];

        if (!room) return socket.emit("gameError", "Cette room n’existe pas.");
        if (room.started) return socket.emit("gameError", "La partie a déjà commencé.");
        if (!name) return socket.emit("gameError", "Entre un pseudo.");
        if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) {
            return socket.emit("gameError", "Ce pseudo est déjà utilisé dans la room.");
        }

        room.players.push({ id: socket.id, name, score: 0 });
        socket.join(code);
        socket.emit("joined", { code, settings: room.settings });
        sendPlayers(code);
    });

    socket.on("startGame", (code) => startRound(String(code || "").toUpperCase(), socket.id));
    socket.on("newGame", (code) => startRound(String(code || "").toUpperCase(), socket.id));

    socket.on("finishTurn", (code) => {
        const roomCode = String(code || "").toUpperCase();
        const room = rooms[roomCode];
        if (!room || room.phase !== "discussion") return;
        if (room.currentSpeakerId !== socket.id) return;
        const player = room.players.find((item) => item.id === socket.id);
        io.to(roomCode).emit("turnFinished", { playerName: player?.name || "Le joueur" });
        advanceTurn(roomCode, socket.id);
    });

    socket.on("vote", ({ code, target } = {}) => {
        const roomCode = String(code || "").toUpperCase();
        const room = rooms[roomCode];
        if (!room || room.phase !== "vote") return;
        if (!room.players.some((player) => player.id === socket.id)) return;
        if (room.votedPlayers.includes(socket.id)) return;
        if (target !== "skip" && !room.players.some((player) => player.id === target)) return;
        if (target === socket.id) return;

        room.votedPlayers.push(socket.id);
        room.votes[target] = (room.votes[target] || 0) + 1;
        io.to(roomCode).emit("voteProgress", { voted: room.votedPlayers.length, total: room.players.length });

        if (room.votedPlayers.length < room.players.length) return;

        let max = 0;
        let winnerIds = [];
        for (const [candidate, count] of Object.entries(room.votes)) {
            if (count > max) {
                max = count;
                winnerIds = [candidate];
            } else if (count === max) {
                winnerIds.push(candidate);
            }
        }

        const eliminatedId = winnerIds.length === 1 && winnerIds[0] !== "skip" ? winnerIds[0] : null;
        const eliminated = eliminatedId ? room.players.find((player) => player.id === eliminatedId) : null;
        const impostorNames = room.players
            .filter((player) => room.roundData?.impostorIds.includes(player.id))
            .map((player) => player.name);
        const correct = Boolean(eliminatedId && room.roundData?.impostorIds.includes(eliminatedId));

        if (correct) {
            for (const player of room.players) {
                if (!room.roundData.impostorIds.includes(player.id)) player.score += 1;
            }
        } else {
            for (const player of room.players) {
                if (room.roundData?.impostorIds.includes(player.id)) player.score += 1;
            }
        }

        room.phase = "result";
        room.started = false;
        io.to(roomCode).emit("voteResult", {
            eliminated: eliminated?.name || null,
            tie: winnerIds.length > 1,
            correct,
            mainSubject: room.roundData?.main?.name || "?",
            mainUniverse: room.roundData?.main?.universe || "",
            fakeSubject: room.roundData?.fake?.name || "?",
            fakeUniverse: room.roundData?.fake?.universe || "",
            impostors: impostorNames
        });
        sendPlayers(roomCode);
    });

    socket.on("chat", ({ code, message } = {}) => {
        const roomCode = String(code || "").toUpperCase();
        const room = rooms[roomCode];
        const player = room?.players.find((item) => item.id === socket.id);
        const cleanMessage = String(message || "").trim().slice(0, 300);
        if (!room || !player || !cleanMessage) return;
        io.to(roomCode).emit("chat", { name: player.name, message: cleanMessage });
    });

    socket.on("disconnect", () => {
        for (const [code, room] of Object.entries(rooms)) {
            const wasHost = room.host === socket.id;
            const wasSpeaker = room.currentSpeakerId === socket.id;
            room.players = room.players.filter((player) => player.id !== socket.id);

            if (!room.players.length) {
                clearRoomTimers(room);
                delete rooms[code];
                continue;
            }

            if (wasHost) {
                room.host = room.players[0].id;
                io.to(room.host).emit("becameHost");
            }
            sendPlayers(code);
            if (wasSpeaker && room.phase === "discussion") advanceTurn(code, socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎭 Imposteur V14 lancé sur le port ${PORT}`));
