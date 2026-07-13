"use strict";

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATABASE_DIR = path.join(PUBLIC_DIR, "database");
const RECONNECT_GRACE_MS = 90_000;
const ROOM_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CHAT_MESSAGES = 35;

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: "1h",
    setHeaders(res, filePath) {
        if (/\.(png|jpg|jpeg|webp|svg|ico)$/i.test(filePath)) {
            res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        }
    }
}));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ["websocket", "polling"],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 100_000,
    perMessageDeflate: false
});

const rooms = new Map();
let database = [];
let availableCategories = [];

const imageSearchCache = new Map();
const imageRegistry = new Map();
const imageBinaryCache = new Map();
let imageBinaryBytes = 0;

function clamp(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function cleanText(value, max = 80) {
    return String(value || "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim()
        .slice(0, max);
}

function makeToken() {
    return crypto.randomBytes(18).toString("base64url");
}

function shuffled(values) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function lruSet(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > maxSize) map.delete(map.keys().next().value);
}

function loadDatabase() {
    database = [];
    if (!fs.existsSync(DATABASE_DIR)) fs.mkdirSync(DATABASE_DIR, { recursive: true });

    const files = fs.readdirSync(DATABASE_DIR).filter((file) => file.endsWith(".json"));
    availableCategories = files.map((file) => path.basename(file, ".json"));

    for (const file of files) {
        const category = path.basename(file, ".json");
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(DATABASE_DIR, file), "utf8"));
            if (!Array.isArray(parsed)) continue;

            for (const entry of parsed) {
                const name = cleanText(entry?.name, 90);
                const universe = cleanText(entry?.universe, 90);
                if (!name || !universe) continue;

                database.push({
                    name,
                    universe,
                    category,
                    difficulty: ["easy", "normal", "hard", "demon"].includes(entry?.difficulty)
                        ? entry.difficulty
                        : "normal",
                    tags: Array.isArray(entry?.tags)
                        ? [...new Set(entry.tags.map((tag) => cleanText(tag, 30).toLowerCase()).filter(Boolean))]
                        : [],
                    image: safeRemoteImageUrl(entry?.image) ? entry.image : null
                });
            }
        } catch (error) {
            console.warn(`Base ignorée (${file}) :`, error.message);
        }
    }

    if (database.length < 2) {
        database = [
            { name: "Naruto", universe: "Naruto", category: "anime", difficulty: "easy", tags: ["ninja", "héros"], image: null },
            { name: "Sasuke", universe: "Naruto", category: "anime", difficulty: "easy", tags: ["ninja", "rival"], image: null },
            { name: "Mario", universe: "Super Mario", category: "games", difficulty: "easy", tags: ["jeu vidéo", "héros"], image: null },
            { name: "Luigi", universe: "Super Mario", category: "games", difficulty: "easy", tags: ["jeu vidéo", "frère"], image: null }
        ];
        availableCategories = ["anime", "games"];
    }

    console.log(`✅ ${database.length} sujets chargés dans ${availableCategories.length} catégories`);
}

function safeRemoteImageUrl(value) {
    try {
        const url = new URL(String(value || ""));
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
    lruSet(imageRegistry, token, url, 400);
    return `/api/image/${token}`;
}

app.get("/api/image/:token", async (req, res) => {
    const token = cleanText(req.params.token, 60);
    const remoteUrl = imageRegistry.get(token);
    if (!remoteUrl) return res.sendStatus(404);

    const cached = imageBinaryCache.get(token);
    if (cached) {
        imageBinaryCache.delete(token);
        imageBinaryCache.set(token, cached);
        res.set("Content-Type", cached.contentType);
        res.set("Cache-Control", "public, max-age=604800, immutable");
        return res.send(cached.data);
    }

    try {
        const response = await axios.get(remoteUrl, {
            responseType: "arraybuffer",
            timeout: 4500,
            maxContentLength: 1024 * 1024,
            headers: {
                "User-Agent": "Anime-Imposteur-V16",
                Accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8"
            }
        });

        const contentType = String(response.headers["content-type"] || "image/jpeg");
        if (!contentType.startsWith("image/")) return res.sendStatus(415);

        const data = Buffer.from(response.data);
        if (data.length > 1024 * 1024) return res.sendStatus(413);

        imageBinaryCache.set(token, { contentType, data });
        imageBinaryBytes += data.length;
        while (imageBinaryCache.size > 16 || imageBinaryBytes > 12 * 1024 * 1024) {
            const oldestKey = imageBinaryCache.keys().next().value;
            const oldest = imageBinaryCache.get(oldestKey);
            imageBinaryBytes -= oldest?.data?.length || 0;
            imageBinaryCache.delete(oldestKey);
        }

        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=604800, immutable");
        return res.send(data);
    } catch {
        return res.sendStatus(404);
    }
});

function buildImageQueries(subject) {
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
        food: "food dish"
    };
    return [
        `${subject.name} ${subject.universe}`,
        `${subject.name} ${suffixes[subject.category] || "character"}`,
        subject.name
    ].map((item) => item.trim()).filter((item, index, list) => item && list.indexOf(item) === index);
}

async function getJikanImage(subject) {
    if (subject.category !== "anime") return null;
    try {
        const response = await axios.get("https://api.jikan.moe/v4/characters", {
            params: { q: subject.name, limit: 4 },
            timeout: 2500,
            headers: { "User-Agent": "Anime-Imposteur-V16" }
        });
        const entries = response.data?.data || [];
        const searched = subject.name.toLowerCase();
        const exact = entries.find((entry) => [entry.name, entry.name_kanji, ...(entry.nicknames || [])]
            .filter(Boolean)
            .map((name) => String(name).toLowerCase())
            .some((name) => name === searched || name.includes(searched) || searched.includes(name)));
        const entry = exact || entries[0];
        return entry?.images?.jpg?.image_url || entry?.images?.jpg?.large_image_url || null;
    } catch {
        return null;
    }
}

async function searchWikipediaImage(subject, language) {
    for (const query of buildImageQueries(subject).slice(0, 1)) {
        try {
            const response = await axios.get(`https://${language}.wikipedia.org/w/api.php`, {
                params: {
                    action: "query",
                    format: "json",
                    origin: "*",
                    generator: "search",
                    gsrsearch: query,
                    gsrlimit: 5,
                    gsrnamespace: 0,
                    prop: "pageimages|pageprops",
                    piprop: "thumbnail",
                    pithumbsize: 520,
                    redirects: 1
                },
                timeout: 2500,
                headers: { "User-Agent": "Anime-Imposteur-V16" }
            });
            const pages = Object.values(response.data?.query?.pages || {})
                .filter((page) => !page.pageprops?.disambiguation)
                .filter((page) => page.thumbnail?.source)
                .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
            const url = pages[0]?.thumbnail?.source || null;
            if (safeRemoteImageUrl(url)) return url;
        } catch {
            // Essaie la requête suivante.
        }
    }
    return null;
}

async function getImage(subject) {
    if (!subject || subject.category === "timmy" || subject.category === "custom" || subject.noImage) {
        return { image: null };
    }
    if (subject.image && safeRemoteImageUrl(subject.image)) {
        return { image: registerRemoteImage(subject.image) };
    }

    const cacheKey = `${subject.category}|${subject.universe}|${subject.name}`.toLowerCase();
    if (imageSearchCache.has(cacheKey)) return imageSearchCache.get(cacheKey);

    const pending = (async () => {
        let remoteImage = subject.category === "anime" ? await getJikanImage(subject) : null;
        if (!remoteImage) remoteImage = await searchWikipediaImage(subject, "fr");
        if (!remoteImage) remoteImage = await searchWikipediaImage(subject, "en");
        return { image: remoteImage ? registerRemoteImage(remoteImage) : null };
    })();

    lruSet(imageSearchCache, cacheKey, pending, 500);
    const result = await pending;
    lruSet(imageSearchCache, cacheKey, Promise.resolve(result), 500);
    return result;
}

function parseCustomSubjects(value) {
    const lines = String(value || "").split(/\r?\n/).slice(0, 120);
    const subjects = [];
    for (const line of lines) {
        const [rawName, rawUniverse = "Personnalisé"] = line.split("|");
        const name = cleanText(rawName, 70);
        const universe = cleanText(rawUniverse, 70) || "Personnalisé";
        if (!name) continue;
        subjects.push({
            name,
            universe,
            category: "custom",
            difficulty: "normal",
            tags: ["personnalisé", universe.toLowerCase()],
            image: null
        });
    }
    return subjects;
}

function normalizeSettings(data = {}) {
    const validCategories = new Set([...availableCategories, "Tout"]);
    const validDifficulties = new Set(["easy", "normal", "hard", "demon"]);
    const validModes = new Set(["classic", "duo", "clue", "blind", "fast", "chaos", "custom"]);

    let categories = Array.isArray(data.categories)
        ? [...new Set(data.categories.map((item) => cleanText(item, 30)).filter((item) => validCategories.has(item)))]
        : ["anime"];
    let difficulties = Array.isArray(data.difficulties)
        ? [...new Set(data.difficulties.map((item) => cleanText(item, 20)).filter((item) => validDifficulties.has(item)))]
        : ["easy"];
    const mode = validModes.has(data.mode) ? data.mode : "classic";
    const customSubjects = parseCustomSubjects(data.customSubjects);

    if (categories.includes("Tout")) categories = ["Tout"];
    if (!categories.length) categories = availableCategories.includes("anime") ? ["anime"] : [availableCategories[0] || "Tout"];
    if (!difficulties.length) difficulties = ["easy"];

    let time = clamp(data.time, 8, 180, 30);
    let cardTime = clamp(data.cardTime, 3, 20, 5);
    let impostors = clamp(data.impostors, 1, 5, 1);
    if (mode === "fast") {
        time = Math.min(time, 15);
        cardTime = Math.min(cardTime, 3);
    }
    if (mode === "duo") impostors = Math.max(2, impostors);

    return {
        categories,
        difficulties,
        linkedMix: Boolean(data.linkedMix),
        mode,
        time,
        cardTime,
        impostors,
        customSubjects,
        customSubjectsText: String(data.customSubjects || "").slice(0, 7000)
    };
}

function publicSettings(settings) {
    return {
        categories: settings.categories,
        difficulties: settings.difficulties,
        linkedMix: settings.linkedMix,
        mode: settings.mode,
        time: settings.time,
        cardTime: settings.cardTime,
        impostors: settings.impostors,
        customSubjectsText: settings.customSubjectsText
    };
}

function getPool(room) {
    if (room.settings.mode === "custom" && room.settings.customSubjects.length >= 2) {
        return room.settings.customSubjects;
    }
    const filtered = database.filter((subject) => {
        const categoryOk = room.settings.categories.includes("Tout") || room.settings.categories.includes(subject.category);
        const difficultyOk = room.settings.difficulties.includes(subject.difficulty);
        return categoryOk && difficultyOk;
    });
    return filtered.length >= 2 ? filtered : database;
}

function sharedTags(a, b) {
    const tags = new Set(b.tags || []);
    return (a.tags || []).filter((tag) => tags.has(tag));
}

function choosePair(room) {
    const pool = getPool(room);
    const recent = new Set(room.recentSubjects.slice(-30));
    const fresh = pool.filter((item) => !recent.has(`${item.category}|${item.name}`));
    const mainPool = fresh.length >= 2 ? fresh : pool;
    const main = mainPool[Math.floor(Math.random() * mainPool.length)];

    let candidates = [];
    if (room.settings.mode === "chaos") {
        candidates = pool.filter((item) => item.name !== main.name);
    } else if (room.settings.linkedMix || room.settings.mode === "clue") {
        candidates = pool
            .filter((item) => item.name !== main.name)
            .map((item) => ({ item, links: sharedTags(main, item) }))
            .filter((entry) => entry.links.length >= 1)
            .sort((a, b) => b.links.length - a.links.length)
            .slice(0, 30)
            .map((entry) => entry.item);
    }

    if (!candidates.length) {
        candidates = pool.filter((item) => item.name !== main.name && item.universe === main.universe);
    }
    if (!candidates.length) {
        candidates = pool.filter((item) => item.name !== main.name && item.category === main.category);
    }
    if (!candidates.length) candidates = pool.filter((item) => item.name !== main.name);

    const fake = candidates[Math.floor(Math.random() * candidates.length)] || main;
    const links = sharedTags(main, fake);
    const clue = links[0] || (main.universe === fake.universe ? main.universe : main.category);
    return { main, fake, links, clue };
}

function createRoomCode() {
    let code;
    do {
        code = crypto.randomBytes(4).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase();
    } while (code.length !== 6 || rooms.has(code));
    return code;
}

function playerByToken(room, token) {
    return room.players.find((player) => player.token === token);
}

function roundParticipantByToken(room, token) {
    const snapshot = room.roundData?.participants?.find((participant) => participant.token === token);
    if (snapshot) return snapshot;

    const player = playerByToken(room, token);
    if (!player) return null;
    return {
        token: player.token,
        name: player.name,
        score: player.score,
        stats: { ...player.stats },
        card: room.roundData?.cards?.[player.token] || null,
        isImpostor: Boolean(room.roundData?.impostorTokens?.includes(player.token))
    };
}

function connectedPlayers(room) {
    return room.players.filter((player) => player.connected);
}

function publicPlayers(room) {
    return room.players.map((player) => ({
        token: player.token,
        name: player.name,
        score: player.score,
        connected: player.connected,
        isHost: player.token === room.hostToken
    }));
}

function emitPlayers(room, force = false) {
    const payload = publicPlayers(room);
    const signature = JSON.stringify(payload);
    if (!force && room.playersSignature === signature) return;
    room.playersSignature = signature;
    io.to(room.code).emit("players", payload);
}

function isHost(socket, room) {
    return socket.data.playerToken && room.hostToken === socket.data.playerToken;
}

function clearRoomTimers(room) {
    for (const timer of room.timers) clearTimeout(timer);
    room.timers.clear();
}

function schedule(room, callback, delay) {
    const timer = setTimeout(() => {
        room.timers.delete(timer);
        callback();
    }, Math.max(0, delay));
    room.timers.add(timer);
    return timer;
}

function touchRoom(room) {
    room.updatedAt = Date.now();
}

function roomPayload(room, token) {
    return {
        code: room.code,
        settings: publicSettings(room.settings),
        round: room.round,
        phase: room.phase,
        phaseEndsAt: room.phaseEndsAt,
        isHost: room.hostToken === token,
        hostToken: room.hostToken,
        currentSpeakerToken: room.order[room.turnIndex] || null,
        turnIndex: room.turnIndex,
        turnTotal: room.order.length,
        started: room.started,
        canEditSettings: room.phase === "lobby" || room.phase === "result",
        result: room.result,
        card: room.roundData?.cards?.[token] || null,
        voteProgress: {
            voted: Object.keys(room.votesByPlayer).length,
            total: room.roundData?.activeTokens?.filter((playerToken) => playerByToken(room, playerToken)?.connected).length || 0
        },
        messages: room.messages.slice(-MAX_CHAT_MESSAGES)
    };
}

function syncSocket(socket, room) {
    socket.emit("roomState", roomPayload(room, socket.data.playerToken));
    socket.emit("players", publicPlayers(room));
}

function addSystemMessage(room, message) {
    const item = { system: true, message: cleanText(message, 180), at: Date.now() };
    room.messages.push(item);
    if (room.messages.length > MAX_CHAT_MESSAGES) room.messages.shift();
    io.to(room.code).emit("chat", item);
}

function removePlayer(room, token, reason = "left") {
    const player = playerByToken(room, token);
    if (!player) return;

    room.players = room.players.filter((item) => item.token !== token);
    room.order = room.order.filter((item) => item !== token);
    if (room.roundData?.activeTokens) room.roundData.activeTokens = room.roundData.activeTokens.filter((item) => item !== token);

    if (room.hostToken === token) {
        room.hostToken = room.players.find((item) => item.connected)?.token || room.players[0]?.token || null;
        if (room.hostToken) io.to(room.code).emit("hostChanged", { hostToken: room.hostToken });
    }

    if (!room.players.length) {
        clearRoomTimers(room);
        rooms.delete(room.code);
        return;
    }

    if (reason === "kicked") io.to(room.code).emit("playerKicked", { token, name: player.name });
    emitPlayers(room);
    touchRoom(room);
}

function cardFor(subject, isImpostor, mode, clue, imageInfo) {
    if (isImpostor && mode === "blind") {
        return {
            character: "Tu es l’imposteur",
            universe: "Observe les indices des autres",
            category: "blind",
            isImpostor: true,
            clue: null,
            image: null
        };
    }
    return {
        character: subject.name,
        universe: subject.universe,
        category: subject.category,
        isImpostor,
        clue: isImpostor && mode === "clue" ? clue : null,
        image: imageInfo?.image || null
    };
}

function immediateImage(subject) {
    if (!subject?.image || !safeRemoteImageUrl(subject.image)) return { image: null };
    return { image: registerRemoteImage(subject.image) };
}

function hydrateRoundImages(room, roundNumber, mainSubject, fakeSubject) {
    Promise.all([getImage(mainSubject), getImage(fakeSubject)]).then(([mainImage, fakeImage]) => {
        const current = rooms.get(room.code);
        if (!current || current.round !== roundNumber || !current.roundData) return;
        for (const token of current.roundData.activeTokens) {
            const isImpostor = current.roundData.impostorTokens.includes(token);
            const image = (isImpostor ? fakeImage : mainImage)?.image || null;
            const card = current.roundData.cards[token];
            if (!card || !image || card.image === image) continue;
            card.image = image;
            const player = playerByToken(current, token);
            if (player?.socketId) io.to(player.socketId).emit("cardImage", { image });
        }
    }).catch(() => {});
}

async function startRound(room) {
    const active = connectedPlayers(room);
    if (active.length < 3) throw new Error("Il faut au moins 3 joueurs connectés.");

    clearRoomTimers(room);
    room.round += 1;
    room.started = true;
    room.phase = "cards";
    room.turnIndex = 0;
    room.votes = {};
    room.votesByPlayer = {};
    room.result = null;

    const pair = choosePair(room);
    const requested = room.settings.mode === "duo" ? Math.max(2, room.settings.impostors) : room.settings.impostors;
    const impostorCount = Math.min(Math.max(1, requested), Math.max(1, active.length - 1));
    const impostorTokens = shuffled(active.map((player) => player.token)).slice(0, impostorCount);
    const order = shuffled(active.map((player) => player.token));
    room.order = order;

    const mainImage = immediateImage(pair.main);
    const fakeImage = immediateImage(pair.fake);
    const cards = {};
    for (const player of active) {
        const impostor = impostorTokens.includes(player.token);
        const subject = impostor ? pair.fake : pair.main;
        cards[player.token] = cardFor(subject, impostor, room.settings.mode, pair.clue, impostor ? fakeImage : mainImage);
        if (impostor) player.stats.impostorRounds += 1;
        player.stats.rounds += 1;
    }

    room.roundData = {
        main: pair.main,
        fake: pair.fake,
        clue: pair.clue,
        impostorTokens,
        activeTokens: active.map((player) => player.token),
        cards,
        participants: active.map((player) => ({
            token: player.token,
            name: player.name,
            score: player.score,
            stats: { ...player.stats },
            card: cards[player.token],
            isImpostor: impostorTokens.includes(player.token)
        }))
    };
    room.recentSubjects.push(`${pair.main.category}|${pair.main.name}`, `${pair.fake.category}|${pair.fake.name}`);
    room.recentSubjects = room.recentSubjects.slice(-40);
    room.phaseEndsAt = Date.now() + Math.max(7000, (room.settings.cardTime + 3) * 1000);
    touchRoom(room);

    io.to(room.code).emit("roundStarted", {
        round: room.round,
        phaseEndsAt: room.phaseEndsAt,
        cardTime: room.settings.cardTime
    });

    for (const player of active) {
        if (player.socketId) io.to(player.socketId).emit("card", cards[player.token]);
    }
    emitPlayers(room);
    hydrateRoundImages(room, room.round, pair.main, pair.fake);

    schedule(room, () => beginDiscussion(room), room.phaseEndsAt - Date.now());
}

function beginDiscussion(room) {
    if (!rooms.has(room.code) || room.phase !== "cards") return;
    room.phase = "discussion";
    room.turnIndex = 0;
    startCurrentTurn(room);
}

function startCurrentTurn(room) {
    if (room.phase !== "discussion") return;

    while (room.turnIndex < room.order.length) {
        const token = room.order[room.turnIndex];
        const player = playerByToken(room, token);
        if (player?.connected) break;
        room.turnIndex += 1;
    }

    if (room.turnIndex >= room.order.length) {
        beginVote(room);
        return;
    }

    clearRoomTimers(room);
    const token = room.order[room.turnIndex];
    const player = playerByToken(room, token);
    room.phaseEndsAt = Date.now() + room.settings.time * 1000;
    touchRoom(room);

    io.to(room.code).emit("turn", {
        token,
        playerName: player?.name || "Joueur",
        turnIndex: room.turnIndex,
        total: room.order.length,
        phaseEndsAt: room.phaseEndsAt
    });

    schedule(room, () => advanceTurn(room, "timer"), room.phaseEndsAt - Date.now());
}

function advanceTurn(room, reason = "manual") {
    if (room.phase !== "discussion") return;
    const previousToken = room.order[room.turnIndex];
    const previous = playerByToken(room, previousToken);
    room.turnIndex += 1;
    io.to(room.code).emit("turnFinished", { playerName: previous?.name || "Joueur", reason });
    startCurrentTurn(room);
}

function beginVote(room) {
    clearRoomTimers(room);
    room.phase = "vote";
    room.votes = {};
    room.votesByPlayer = {};
    room.phaseEndsAt = Date.now() + 45_000;
    touchRoom(room);

    const candidates = room.roundData.activeTokens
        .map((token) => playerByToken(room, token))
        .filter(Boolean)
        .map((player) => ({ token: player.token, name: player.name, connected: player.connected }));

    io.to(room.code).emit("votePhase", {
        players: candidates,
        phaseEndsAt: room.phaseEndsAt
    });

    schedule(room, () => finalizeVote(room), room.phaseEndsAt - Date.now());
}

function voteTargetsWithNames(room) {
    return Object.entries(room.votesByPlayer).map(([voterToken, targetToken]) => ({
        voterToken,
        voterName: roundParticipantByToken(room, voterToken)?.name || "Joueur",
        targetToken,
        targetName: targetToken === "skip" ? "Personne" : (roundParticipantByToken(room, targetToken)?.name || "Joueur")
    }));
}

function finalizeVote(room) {
    if (room.phase !== "vote") return;
    clearRoomTimers(room);

    let max = 0;
    let winners = [];
    for (const [target, count] of Object.entries(room.votes)) {
        if (count > max) {
            max = count;
            winners = [target];
        } else if (count === max) {
            winners.push(target);
        }
    }

    const eliminatedToken = winners.length === 1 && winners[0] !== "skip" ? winners[0] : null;
    const eliminatedParticipant = eliminatedToken ? roundParticipantByToken(room, eliminatedToken) : null;
    const correct = Boolean(eliminatedToken && room.roundData.impostorTokens.includes(eliminatedToken));
    const tie = winners.length > 1;

    const roundParticipants = (room.roundData.participants?.length
        ? room.roundData.participants
        : room.roundData.activeTokens.map((token) => roundParticipantByToken(room, token)).filter(Boolean));

    for (const participant of roundParticipants) {
        const player = playerByToken(room, participant.token);
        if (!player) continue;
        if (correct && !room.roundData.impostorTokens.includes(player.token)) {
            player.score += 1;
            player.stats.wins += 1;
        }
        if (!correct && room.roundData.impostorTokens.includes(player.token)) {
            player.score += 1;
            player.stats.wins += 1;
        }
        if (correct && !room.roundData.impostorTokens.includes(player.token)) player.stats.correctVotes += 1;
    }

    const resultPlayers = roundParticipants.map((participant) => {
        const livePlayer = playerByToken(room, participant.token);
        return {
            token: participant.token,
            name: participant.name,
            score: livePlayer?.score ?? participant.score ?? 0,
            card: participant.card || room.roundData.cards[participant.token] || null,
            isImpostor: room.roundData.impostorTokens.includes(participant.token),
            stats: livePlayer?.stats || participant.stats || { rounds: 0, wins: 0, impostorRounds: 0, correctVotes: 0 }
        };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));

    const result = {
        eliminated: eliminatedParticipant?.name || null,
        eliminatedToken,
        eliminatedCard: eliminatedParticipant?.card || (eliminatedToken ? room.roundData.cards[eliminatedToken] : null),
        eliminatedIsImpostor: Boolean(eliminatedToken && room.roundData.impostorTokens.includes(eliminatedToken)),
        tie,
        correct,
        mainSubject: room.roundData.main.name,
        mainUniverse: room.roundData.main.universe,
        fakeSubject: room.settings.mode === "blind" ? "Aucun sujet" : room.roundData.fake.name,
        fakeUniverse: room.settings.mode === "blind" ? "Mode aveugle" : room.roundData.fake.universe,
        impostors: room.roundData.impostorTokens.map((token) => roundParticipantByToken(room, token)?.name).filter(Boolean),
        votes: voteTargetsWithNames(room),
        players: resultPlayers
    };

    room.result = result;
    room.phase = "result";
    room.started = false;
    room.phaseEndsAt = null;
    touchRoom(room);
    io.to(room.code).emit("voteResult", result);
    emitPlayers(room);
}
function connectedRoundTokens(room) {
    return (room.roundData?.activeTokens || []).filter((token) => playerByToken(room, token)?.connected);
}

function maybeFinalizeVote(room) {
    if (room.phase !== "vote") return;
    const eligible = connectedRoundTokens(room);
    if (eligible.length && eligible.every((token) => room.votesByPlayer[token])) finalizeVote(room);
}

function createPlayer(token, socket, name) {
    return {
        token,
        socketId: socket.id,
        name,
        score: 0,
        connected: true,
        joinedAt: Date.now(),
        disconnectedAt: null,
        stats: { rounds: 0, wins: 0, impostorRounds: 0, correctVotes: 0 }
    };
}

function attachPlayer(socket, room, player) {
    if (player.socketId && player.socketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(player.socketId);
        if (previousSocket) {
            previousSocket.emit("sessionReplaced");
            previousSocket.leave(room.code);
            previousSocket.data.roomCode = null;
            previousSocket.disconnect(true);
        }
    }
    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAt = null;
    socket.data.roomCode = room.code;
    socket.join(room.code);
    touchRoom(room);
}

function joinExistingOrCreate(socket, room, name) {
    const token = socket.data.playerToken;
    let player = playerByToken(room, token);
    if (player) {
        player.name = name || player.name;
        attachPlayer(socket, room, player);
        return { player, reconnected: true };
    }
    if (room.phase !== "lobby" && room.phase !== "result") throw new Error("La partie a déjà commencé.");
    if (room.players.length >= 20) throw new Error("La room est pleine.");
    if (room.players.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("Ce pseudo est déjà utilisé dans la room.");
    }
    player = createPlayer(token, socket, name);
    room.players.push(player);
    attachPlayer(socket, room, player);
    return { player, reconnected: false };
}

io.use((socket, next) => {
    const provided = cleanText(socket.handshake.auth?.playerToken, 80);
    socket.data.playerToken = provided && /^[A-Za-z0-9_-]{12,80}$/.test(provided) ? provided : makeToken();
    next();
});

io.on("connection", (socket) => {
    socket.emit("identity", { playerToken: socket.data.playerToken });

    socket.on("createRoom", (data = {}) => {
        try {
            const name = cleanText(data.name, 18);
            if (!name) throw new Error("Entre un pseudo.");
            const code = createRoomCode();
            const settings = normalizeSettings(data);
            const player = createPlayer(socket.data.playerToken, socket, name);
            const room = {
                code,
                hostToken: player.token,
                players: [player],
                settings,
                round: 0,
                phase: "lobby",
                phaseEndsAt: null,
                started: false,
                order: [],
                turnIndex: 0,
                votes: {},
                votesByPlayer: {},
                roundData: null,
                result: null,
                recentSubjects: [],
                messages: [],
                playersSignature: "",
                timers: new Set(),
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            rooms.set(code, room);
            attachPlayer(socket, room, player);
            socket.emit("roomCreated", { code, settings: publicSettings(settings), isHost: true });
            syncSocket(socket, room);
        } catch (error) {
            socket.emit("gameError", error.message);
        }
    });

    socket.on("joinRoom", (data = {}) => {
        try {
            const code = cleanText(data.code, 6).toUpperCase();
            const name = cleanText(data.name, 18);
            const room = rooms.get(code);
            if (!room) throw new Error("Room introuvable.");
            if (!name) throw new Error("Entre un pseudo.");

            const { reconnected } = joinExistingOrCreate(socket, room, name);
            socket.emit("joined", { code, settings: publicSettings(room.settings), isHost: isHost(socket, room), reconnected });
            addSystemMessage(room, reconnected ? `${name} est revenu dans la partie.` : `${name} a rejoint la partie.`);
            syncSocket(socket, room);
            emitPlayers(room);
        } catch (error) {
            socket.emit("gameError", error.message);
        }
    });

    socket.on("reconnectRoom", (data = {}) => {
        const code = cleanText(data.code, 6).toUpperCase();
        const room = rooms.get(code);
        if (!room) return socket.emit("reconnectFailed");
        const player = playerByToken(room, socket.data.playerToken);
        if (!player) return socket.emit("reconnectFailed");
        if (cleanText(data.name, 18)) player.name = cleanText(data.name, 18);
        attachPlayer(socket, room, player);
        socket.emit("joined", { code, settings: publicSettings(room.settings), isHost: isHost(socket, room), reconnected: true });
        syncSocket(socket, room);
        emitPlayers(room);
    });

    socket.on("requestSync", (codeValue) => {
        const room = rooms.get(cleanText(codeValue, 6).toUpperCase());
        if (!room) return socket.emit("reconnectFailed");
        const player = playerByToken(room, socket.data.playerToken);
        if (!player || player.socketId !== socket.id) return;
        syncSocket(socket, room);
    });

    socket.on("startGame", async (codeValue) => {
        const code = cleanText(codeValue, 6).toUpperCase();
        const room = rooms.get(code);
        if (!room || !isHost(socket, room)) return;
        if (!["lobby", "result"].includes(room.phase)) return;
        try {
            await startRound(room);
        } catch (error) {
            socket.emit("gameError", error.message);
        }
    });

    socket.on("newGame", async (codeValue) => {
        const code = cleanText(codeValue, 6).toUpperCase();
        const room = rooms.get(code);
        if (!room || !isHost(socket, room)) return;
        try {
            await startRound(room);
        } catch (error) {
            socket.emit("gameError", error.message);
        }
    });

    socket.on("returnLobby", (codeValue) => {
        const room = rooms.get(cleanText(codeValue, 6).toUpperCase());
        if (!room || !isHost(socket, room)) return;
        clearRoomTimers(room);
        room.phase = "lobby";
        room.phaseEndsAt = null;
        room.started = false;
        room.order = [];
        room.turnIndex = 0;
        room.votes = {};
        room.votesByPlayer = {};
        room.roundData = null;
        room.result = null;
        touchRoom(room);
        io.to(room.code).emit("returnedToLobby");
        emitPlayers(room);
    });

    socket.on("updateSettings", (data = {}) => {
        const room = rooms.get(cleanText(data.code, 6).toUpperCase());
        if (!room || !isHost(socket, room) || !["lobby", "result"].includes(room.phase)) return;
        room.settings = normalizeSettings(data.settings || {});
        touchRoom(room);
        io.to(room.code).emit("settingsUpdated", publicSettings(room.settings));
    });

    socket.on("finishTurn", (codeValue) => {
        const room = rooms.get(cleanText(codeValue, 6).toUpperCase());
        if (!room || room.phase !== "discussion") return;
        const currentToken = room.order[room.turnIndex];
        if (socket.data.playerToken !== currentToken && !isHost(socket, room)) return;
        advanceTurn(room, "manual");
    });

    socket.on("hostNextPhase", (codeValue) => {
        const room = rooms.get(cleanText(codeValue, 6).toUpperCase());
        if (!room || !isHost(socket, room)) return;
        if (room.phase === "cards") beginDiscussion(room);
        else if (room.phase === "discussion") advanceTurn(room, "host");
        else if (room.phase === "vote") finalizeVote(room);
    });

    socket.on("addTime", ({ code, seconds } = {}) => {
        const room = rooms.get(cleanText(code, 6).toUpperCase());
        if (!room || !isHost(socket, room) || !["cards", "discussion", "vote"].includes(room.phase)) return;
        const extra = clamp(seconds, 5, 60, 15) * 1000;
        room.phaseEndsAt = Math.max(Date.now(), room.phaseEndsAt || Date.now()) + extra;
        clearRoomTimers(room);
        if (room.phase === "cards") schedule(room, () => beginDiscussion(room), room.phaseEndsAt - Date.now());
        if (room.phase === "discussion") schedule(room, () => advanceTurn(room, "timer"), room.phaseEndsAt - Date.now());
        if (room.phase === "vote") schedule(room, () => finalizeVote(room), room.phaseEndsAt - Date.now());
        io.to(room.code).emit("timeAdded", { phaseEndsAt: room.phaseEndsAt, seconds: extra / 1000 });
    });

    socket.on("vote", ({ code, target } = {}) => {
        const room = rooms.get(cleanText(code, 6).toUpperCase());
        const voterToken = socket.data.playerToken;
        if (!room || room.phase !== "vote" || room.votesByPlayer[voterToken]) return;
        if (!room.roundData?.activeTokens.includes(voterToken)) return;
        const cleanTarget = target === "skip" ? "skip" : cleanText(target, 80);
        if (cleanTarget !== "skip" && !room.roundData.activeTokens.includes(cleanTarget)) return;
        if (cleanTarget === voterToken) return;

        room.votesByPlayer[voterToken] = cleanTarget;
        room.votes[cleanTarget] = (room.votes[cleanTarget] || 0) + 1;
        const eligible = connectedRoundTokens(room);
        io.to(room.code).emit("voteProgress", {
            voted: Object.keys(room.votesByPlayer).length,
            total: eligible.length
        });
        maybeFinalizeVote(room);
    });

    socket.on("chat", ({ code, message } = {}) => {
        const room = rooms.get(cleanText(code, 6).toUpperCase());
        const player = room ? playerByToken(room, socket.data.playerToken) : null;
        const cleanMessage = cleanText(message, 300);
        if (!room || !player || !cleanMessage) return;
        const item = { name: player.name, message: cleanMessage, at: Date.now() };
        room.messages.push(item);
        if (room.messages.length > MAX_CHAT_MESSAGES) room.messages.shift();
        io.to(room.code).emit("chat", item);
    });

    socket.on("kickPlayer", ({ code, token } = {}) => {
        const room = rooms.get(cleanText(code, 6).toUpperCase());
        const targetToken = cleanText(token, 80);
        if (!room || !isHost(socket, room) || targetToken === room.hostToken) return;
        const target = playerByToken(room, targetToken);
        if (!target) return;
        if (target.socketId) io.to(target.socketId).emit("kicked", { reason: "Tu as été expulsé de la room." });
        removePlayer(room, targetToken, "kicked");
    });

    socket.on("transferHost", ({ code, token } = {}) => {
        const room = rooms.get(cleanText(code, 6).toUpperCase());
        const targetToken = cleanText(token, 80);
        if (!room || !isHost(socket, room) || !playerByToken(room, targetToken)) return;
        room.hostToken = targetToken;
        touchRoom(room);
        io.to(room.code).emit("hostChanged", { hostToken: targetToken });
        emitPlayers(room);
    });

    socket.on("leaveRoom", (codeValue) => {
        const room = rooms.get(cleanText(codeValue, 6).toUpperCase());
        if (!room) return;
        socket.leave(room.code);
        removePlayer(room, socket.data.playerToken, "left");
        socket.data.roomCode = null;
    });

    socket.on("disconnect", () => {
        const code = socket.data.roomCode;
        const room = code ? rooms.get(code) : null;
        if (!room) return;
        const player = playerByToken(room, socket.data.playerToken);
        if (!player || player.socketId !== socket.id) return;

        player.connected = false;
        player.socketId = null;
        player.disconnectedAt = Date.now();
        emitPlayers(room);
        touchRoom(room);

        schedule(room, () => {
            const currentRoom = rooms.get(room.code);
            const currentPlayer = currentRoom && playerByToken(currentRoom, player.token);
            if (!currentRoom || !currentPlayer || currentPlayer.connected) return;
            removePlayer(currentRoom, currentPlayer.token, "timeout");
            if (currentRoom.phase === "discussion" && currentRoom.order[currentRoom.turnIndex] === currentPlayer.token) {
                advanceTurn(currentRoom, "disconnect");
            }
            maybeFinalizeVote(currentRoom);
        }, RECONNECT_GRACE_MS);
    });
});

setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
        if (now - room.updatedAt > ROOM_IDLE_TTL_MS) {
            clearRoomTimers(room);
            io.to(room.code).emit("roomExpired");
            rooms.delete(room.code);
        }
    }
}, 15 * 60 * 1000).unref();

app.get("/api/health", (_req, res) => {
    res.json({ ok: true, rooms: rooms.size, subjects: database.length, version: "16.1.0" });
});

app.get("*", (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

loadDatabase();
server.listen(PORT, () => console.log(`🎭 Anime Imposteur V16.1 lancé sur le port ${PORT}`));
