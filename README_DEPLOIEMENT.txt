ANIME IMPOSTEUR V15 — INSTALLATION ET DÉPLOIEMENT
==================================================

Ce dossier contient le projet complet. Il remplace la version précédente :
- server.js
- package.json et package-lock.json
- tout le dossier public
- toutes les bases de données
- logo, favicon et image d’aperçu du lien

MISE À JOUR DU SITE RENDER
--------------------------
1. Décompresse Anime-Imposteur-V15-Complet.zip.
2. Remplace les fichiers de ton ancien projet par tous les fichiers de ce dossier.
3. Ouvre un terminal dans le dossier Anime-Imposteur-V15.
4. Lance :

npm install
npm run check
git add .
git commit -m "Passage a la V15 optimisee"
git push

Render redéploiera automatiquement le site.
La commande de démarrage reste : npm start
Le port est récupéré automatiquement depuis Render.

APRÈS LE DÉPLOIEMENT
--------------------
Fais Ctrl + F5 une fois sur le site pour forcer le navigateur à prendre les nouveaux fichiers.
Le service worker supprimera l’ancien cache de la V14 et installera le cache V15.

PRINCIPAUX AJOUTS
-----------------
- Reconnexion automatique pendant 90 secondes après une coupure ou une actualisation.
- Conservation de la room, du rôle, de la carte et de la phase en cours.
- Boutons pour copier le code, copier le lien et afficher un QR code.
- Écran de résultat complet avec cartes, votes, classement et imposteurs.
- Rejouer avec les mêmes joueurs ou retourner au salon.
- Contrôles d’hôte : expulsion, transfert d’hôte, ajout de temps, étape suivante et réglages.
- Modes Classique, Duo, Indice, Aveugle, Rapide, Chaos et Personnalisé.
- Roue des joueurs et mise en avant du joueur qui parle.
- Sons, vibrations, statistiques locales et installation comme application PWA.
- Confirmation avant de quitter et carte masquée automatiquement.

OPTIMISATIONS RAM ET FLUIDITÉ
-----------------------------
- Les recherches d’images ne sont plus répétées dans chaque onglet.
- Cache d’images serveur limité en taille et en nombre.
- Maximum de 60 messages affichés dans le chat.
- Mode léger automatique lorsque plusieurs onglets du jeu sont ouverts.
- Arrêt des animations lourdes et du flou dans les onglets secondaires ou masqués.
- Suspension du son et ralentissement des minuteries dans les onglets masqués.
- Libération de l’image de la carte une fois qu’elle est cachée.
- Compression WebSocket coûteuse désactivée pour réduire la charge CPU et mémoire.

ADRESSE DU SITE
---------------
https://anime-impostor.onrender.com/
