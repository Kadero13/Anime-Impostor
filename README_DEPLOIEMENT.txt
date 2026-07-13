ANIME IMPOSTEUR V16 — INSTALLATION ET DÉPLOIEMENT
=================================================

Cette archive remplace entièrement la V15.

1. Décompresse Anime-Imposteur-V16-Ultra.zip.
2. Remplace tous les fichiers de ton ancien projet par ceux du nouveau dossier.
3. Ouvre un terminal dans le dossier du projet.
4. Exécute :

npm install
npm run check
git add .
git commit -m "Passage a la V16 ultra optimisee"
git push

Render redéploiera automatiquement le site.

Après le déploiement :
- ouvre https://anime-impostor.onrender.com/
- fais Ctrl + F5 une fois ;
- ferme les anciens onglets encore ouverts avant le premier test ;
- ouvre ensuite 3 nouveaux onglets pour tester.

Le cache du service worker porte maintenant un nouveau nom V16. Les anciens fichiers V15 seront supprimés automatiquement.
