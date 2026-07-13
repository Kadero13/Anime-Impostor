const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const DATABASE_DIR = path.join(__dirname, "public", "database");
let database = [];
const imageCache = new Map();
const rooms = {};

function loadDatabase() {
    database = [];
    const files = fs.readdirSync(DATABASE_DIR).filter((file) => file.endsWith(".json"));

    for (const file of files) {
        const category = file.replace(".json", "");
        const content = JSON.parse(fs.readFileSync(path.join(DATABASE_DIR, file), "utf8"));

        for (const subject of content) {
            if (!subject.name || !subject.universe) continue;
            database.push({
                ...subject,
                category,
                tags: Array.isArray(subject.tags) ? subject.tags.map((tag) => String(tag).toLowerCase()) : []
            });
        }
    }

    console.log(`✅ ${database.length} sujets chargés dans ${files.length} catégories`);
}

loadDatabase();

function buildImageSearchQueries(subject) {
    const name = String(subject?.name || "").trim();
    const universe = String(subject?.universe || "").trim();
    const category = String(subject?.category || "").trim();
    const suffixes = {
        anime: "anime character",
        games: "video game character",
        movie: "film character",
        series: "TV character",
        marvel: "Marvel character",
        sport: "athlete"
    };

    return [
        `${name} ${universe}`.trim(),
        `${name} ${suffixes[category] || "character"}`.trim(),
        name
    ].filter((query, index, array) => query && array.indexOf(query) === index);
}

async function getJikanImage(subject) {
    if (subject?.category !== "anime") return null;

    try {
        const response = await axios.get("https://api.jikan.moe/v4/characters", {
            params: { q: subject.name, limit: 5 },
            timeout: 5000,
            headers: { "User-Agent": "Anime-Imposteur/12" }
        });

        const candidates = response.data?.data || [];
        const exactName = String(subject.name).toLowerCase();
        const exact = candidates.find((entry) => {
            const names = [entry.name, entry.name_kanji, ...(entry.nicknames || [])]
                .filter(Boolean)
                .map((value) => String(value).toLowerCase());
            return names.some((value) => value === exactName || value.includes(exactName) || exactName.includes(value));
        });

        return (exact || candidates[0])?.images?.jpg?.large_image_url
            || (exact || candidates[0])?.images?.jpg?.image_url
            || null;
    } catch {
        return null;
    }
}

async function searchWikipediaImage(subject, language) {
    const queries = buildImageSearchQueries(subject);

    for (const query of queries) {
        try {
            const response = await axios.get(`https://${language}.wikipedia.org/w/api.php`, {
                params: {
                    action: "query",
                    format: "json",
                    origin: "*",
                    generator: "search",
                    gsrsearch: query,
                    gsrlimit: 6,
                    gsrnamespace: 0,
                    prop: "pageimages|pageprops",
                    piprop: "thumbnail|original",
                    pithumbsize: 700,
                    pilicense: "any",
                    redirects: 1
                },
                timeout: 6000,
                headers: {
                    "User-Agent": "Anime-Imposteur/12 (automatic character images)"
                }
            });

            const pages = Object.values(response.data?.query?.pages || {})
                .filter((page) => page.thumbnail?.source || page.original?.source)
                .filter((page) => !page.pageprops?.disambiguation)
                .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

            if (pages.length) {
                return pages[0].thumbnail?.source || pages[0].original?.source || null;
            }
        } catch {
            // Essaie la requête suivante ou une autre langue.
        }
    }

    return null;
}

function createFallbackImage(subject) {
    const initials = String(subject?.name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join("");
    const title = String(subject?.name || "Sujet").replace(/[<>&"']/g, "");
    const universe = String(subject?.universe || "").replace(/[<>&"']/g, "");
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="700" height="700" viewBox="0 0 700 700">
            <defs>
                <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#19132f"/>
                    <stop offset="0.55" stop-color="#31206b"/>
                    <stop offset="1" stop-color="#0b67b2"/>
                </linearGradient>
            </defs>
            <rect width="700" height="700" rx="48" fill="url(#g)"/>
            <circle cx="350" cy="285" r="145" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.3)" stroke-width="8"/>
            <text x="350" y="330" text-anchor="middle" font-family="Arial, sans-serif" font-size="150" font-weight="700" fill="white">${initials}</text>
            <text x="350" y="515" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="white">${title.slice(0, 25)}</text>
            <text x="350" y="570" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" fill="#cbd8ff">${universe.slice(0, 34)}</text>
        </svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function getImage(subject) {
    if (!subject) return null;

    if (subject.image && /^https?:\/\//i.test(subject.image)) return subject.image;

    const cacheKey = `${subject.category}|${subject.universe}|${subject.name}`.toLowerCase();
    if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);

    let image = await getJikanImage(subject);
    if (!image) image = await searchWikipediaImage(subject, "en");
    if (!image) image = await searchWikipediaImage(subject, "fr");
    if (!image) image = createFallbackImage(subject);

    imageCache.set(cacheKey, image);
    return image;
}

function normalizeSettings(data = {}) {
    const validCategories = ["anime", "games", "movie", "series", "marvel", "sport", "Tout"];
    const validDifficulties = ["easy", "normal", "hard", "demon"];

    let categories = Array.isArray(data.categories)
        ? [...new Set(data.categories.filter((value) => validCategories.includes(value)))]
        : ["anime"];
    let difficulties = Array.isArray(data.difficulties)
        ? [...new Set(data.difficulties.filter((value) => validDifficulties.includes(value)))]
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

function weightedChoice(items, weightFn) {
    if (!items.length) return null;
    const weighted = items.map((item) => ({ item, weight: Math.max(1, weightFn(item)) }));
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let cursor = Math.random() * total;

    for (const entry of weighted) {
        cursor -= entry.weight;
        if (cursor <= 0) return entry.item;
    }
    return weighted.at(-1).item;
}

function choosePair(room) {
    const pool = getPool(room);
    const recentNames = new Set(room.recentSubjects.slice(-20));
    const freshPool = pool.filter((subject) => !recentNames.has(subject.name));
    const mainPool = freshPool.length >= 2 ? freshPool : pool;
    const main = mainPool[Math.floor(Math.random() * mainPool.length)];

    let candidates;

    if (room.settings.linkedMix) {
        candidates = pool
            .filter((candidate) =>
                candidate.name !== main.name &&
                candidate.universe !== main.universe &&
                candidate.category !== main.category
            )
            .map((candidate) => ({ candidate, links: sharedTags(main, candidate) }))
            .filter((entry) => entry.links.length >= 2);

        const selected = weightedChoice(candidates, (entry) => {
            const freshness = recentNames.has(entry.candidate.name) ? 1 : 5;
            return (entry.links.length ** 3) * freshness;
        });

        if (selected) {
            return { main, fake: selected.candidate, links: selected.links };
        }
    }

    candidates = pool.filter((candidate) =>
        candidate.name !== main.name &&
        candidate.universe === main.universe &&
        candidate.category === main.category
    );

    if (!candidates.length) {
        candidates = pool
            .filter((candidate) => candidate.name !== main.name)
            .map((candidate) => ({ candidate, links: sharedTags(main, candidate) }))
            .filter((entry) => entry.links.length >= 2);
        const selected = weightedChoice(candidates, (entry) => entry.links.length ** 3);
        if (selected) return { main, fake: selected.candidate, links: selected.links };
    }

    const fake = candidates[Math.floor(Math.random() * candidates.length)] || main;
    return { main, fake, links: sharedTags(main, fake) };
}

function chooseImpostors(players, requestedCount) {
    const count = Math.min(Math.max(1, requestedCount), Math.max(1, players.length - 1));
    return [...players]
        .sort(() => Math.random() - 0.5)
        .slice(0, count)
        .map((player) => player.id);
}

function createRoomCode() {
    let code;
    do code = Math.random().toString(36).slice(2, 8).toUpperCase(); while (rooms[code]);
    return code;
}

function publicPlayers(room) {
    return room.players.map((player) => ({ id: player.id, name: player.name, score: player.score }));
}

function sendPlayers(code) {
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit("players", publicPlayers(room));
}

function clearRoomTimers(room) {
    for (const timer of room.timers) clearTimeout(timer);
    room.timers = [];
}

function schedule(room, callback, delay) {
    const timer = setTimeout(callback, delay);
    room.timers.push(timer);
}

function beginVote(code) {
    const room = rooms[code];
    if (!room || !room.started) return;
    room.phase = "vote";
    room.votes = {};
    room.votedPlayers = [];
    io.to(code).emit("votePhase", { players: publicPlayers(room) });
}

function beginSpeakingTurns(code) {
    const room = rooms[code];
    if (!room || !room.started || !room.players.length) return;

    room.phase = "discussion";
    room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
    room.currentTurnIndex = 0;

    const launchTurn = () => {
        const currentRoom = rooms[code];
        if (!currentRoom || currentRoom.phase !== "discussion") return;

        while (
            currentRoom.currentTurnIndex < currentRoom.turnOrder.length &&
            !currentRoom.players.some((player) => player.id === currentRoom.turnOrder[currentRoom.currentTurnIndex].id)
        ) {
            currentRoom.currentTurnIndex += 1;
        }

        if (currentRoom.currentTurnIndex >= currentRoom.turnOrder.length) {
            beginVote(code);
            return;
        }

        const player = currentRoom.turnOrder[currentRoom.currentTurnIndex];
        io.to(code).emit("speakingTurn", {
            playerId: player.id,
            playerName: player.name,
            turnNumber: currentRoom.currentTurnIndex + 1,
            totalTurns: currentRoom.turnOrder.length,
            time: currentRoom.settings.time
        });

        schedule(currentRoom, () => {
            const latest = rooms[code];
            if (!latest || latest.phase !== "discussion") return;
            latest.currentTurnIndex += 1;
            launchTurn();
        }, currentRoom.settings.time * 1000);
    };

    launchTurn();
}

async function startRound(code, socketId) {
    const room = rooms[code];
    if (!room) return;
    if (room.host !== socketId) return io.to(socketId).emit("gameError", "Seul l’hôte peut lancer la manche.");
    if (room.players.length < 3) return io.to(socketId).emit("gameError", "Il faut au moins 3 joueurs.");

    clearRoomTimers(room);
    room.round += 1;
    room.started = true;
    room.phase = "cards";
    room.votes = {};
    room.votedPlayers = [];

    const { main, fake, links } = choosePair(room);
    room.recentSubjects.push(main.name, fake.name);
    if (room.recentSubjects.length > 40) room.recentSubjects.splice(0, room.recentSubjects.length - 40);

    const impostors = chooseImpostors(room.players, room.settings.impostors);
    const [mainImage, fakeImage] = await Promise.all([getImage(main), getImage(fake)]);

    for (const player of room.players) {
        const isImpostor = impostors.includes(player.id);
        const subject = isImpostor ? fake : main;
        io.to(player.id).emit("card", {
            character: subject.name,
            universe: subject.universe,
            category: subject.category,
            image: isImpostor ? fakeImage : mainImage
        });
    }

    console.log(`[${code}] ${main.name} VS ${fake.name} | liens: ${links.join(", ") || "même univers"}`);

    const preparationTime = room.settings.cardTime + 8;
    io.to(code).emit("cardPhase", {
        round: room.round,
        cardTime: room.settings.cardTime,
        preparationTime
    });
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
            recentSubjects: []
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

    socket.on("vote", ({ code, target } = {}) => {
        const room = rooms[String(code || "").toUpperCase()];
        if (!room || room.phase !== "vote") return;
        if (!room.players.some((player) => player.id === socket.id)) return;
        if (room.votedPlayers.includes(socket.id)) return;
        if (target !== "skip" && !room.players.some((player) => player.id === target)) return;

        room.votedPlayers.push(socket.id);
        room.votes[target] = (room.votes[target] || 0) + 1;
        io.to(code).emit("voteProgress", { voted: room.votedPlayers.length, total: room.players.length });

        if (room.votedPlayers.length < room.players.length) return;

        let max = 0;
        let winners = [];
        for (const [candidate, count] of Object.entries(room.votes)) {
            if (count > max) {
                max = count;
                winners = [candidate];
            } else if (count === max) {
                winners.push(candidate);
            }
        }

        const winnerId = winners.length === 1 && winners[0] !== "skip" ? winners[0] : null;
        const eliminated = winnerId ? room.players.find((player) => player.id === winnerId) : null;
        room.phase = "result";
        room.started = false;

        io.to(code).emit("voteResult", {
            eliminated: eliminated?.name || null,
            tie: winners.length > 1
        });
    });

    socket.on("chat", ({ code, message } = {}) => {
        const room = rooms[String(code || "").toUpperCase()];
        const player = room?.players.find((item) => item.id === socket.id);
        const cleanMessage = String(message || "").trim().slice(0, 300);
        if (!room || !player || !cleanMessage) return;
        io.to(code).emit("chat", { name: player.name, message: cleanMessage });
    });

    socket.on("disconnect", () => {
        for (const [code, room] of Object.entries(rooms)) {
            const wasHost = room.host === socket.id;
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
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎭 Imposteur V12 lancé sur le port ${PORT}`));
