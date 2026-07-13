ANIME IMPOSTEUR V14.1 — CORRECTIF RENDER

Structure obligatoire à la racine du dépôt GitHub :
- package.json
- package-lock.json
- server.js
- public/

Réglages Render :
- Runtime : Node
- Root Directory : laisser vide
- Build Command : npm ci
- Start Command : npm start

Ne place pas tout le projet dans un sous-dossier "Anime-Imposteur-V14.1-Render-Fix" sur GitHub.
Les fichiers package.json et server.js doivent être directement visibles à la racine du dépôt.

Publication :
git add .
git commit -m "Correctif Render V14.1"
git push
