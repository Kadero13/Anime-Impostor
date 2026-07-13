ANIME IMPOSTEUR V16.1 — CORRECTION DU VOTE

Cette version corrige le résultat lorsqu’un joueur innocent est éliminé.
Le jeu affiche maintenant son nom, sa carte et son univers, puis attribue correctement la victoire à l’imposteur.
La correction reste fiable même si le joueur éliminé se déconnecte avant l’écran de résultat.

INSTALLATION

1. Décompresse Anime-Imposteur-V16-1-Fix-Vote.zip.
2. Remplace entièrement les fichiers de ton ancien projet par ceux du dossier extrait.
3. Dans le terminal ouvert dans le projet :

npm install
npm run check
git add .
git commit -m "Correction affichage joueur elimine"
git push

4. Attends le redéploiement automatique de Render.
5. Ferme les anciens onglets du jeu puis ouvre :
https://anime-impostor.onrender.com/
6. Fais Ctrl + F5 une fois pour forcer le nouveau cache.
