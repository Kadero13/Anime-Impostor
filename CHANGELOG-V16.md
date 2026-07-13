# Anime Imposteur V16 — Ultra Performance

## Corrections principales

- Correction du conflit d’identifiant quand Chrome duplique un onglet.
- Une ancienne connexion portant le même identifiant est maintenant nettoyée côté serveur.
- Suppression de la double demande de reconnexion au chargement.
- Les onglets masqués ne reconstruisent plus l’interface : ils demandent un état propre lorsqu’ils redeviennent visibles.

## Fluidité côté navigateur

- Suppression des flous en temps réel, des grosses ombres et des animations infinies.
- Carte retournée avec un fondu léger au lieu d’une transformation 3D coûteuse.
- Minuteur limité à une mise à jour par seconde au lieu de quatre.
- Liste des joueurs et roue de parole reconstruites uniquement quand leur contenu change.
- Vote géré avec un seul écouteur partagé au lieu d’un écouteur par joueur.
- Historique du chat limité à 35 messages et rendu en une seule opération DOM.
- Mode ultra léger automatique dès qu’un autre onglet du jeu est ouvert.
- Connexion Socket.IO directement en WebSocket, sans phase de polling.

## Fluidité côté serveur

- La partie démarre immédiatement sans attendre Jikan ou Wikipédia.
- Les images sont recherchées en arrière-plan puis envoyées séparément.
- Recherche d’image allégée et séquentielle, avec délais plus courts.
- Cache d’images réduit à 16 entrées et 12 Mo.
- Émissions de liste des joueurs supprimées lorsque la liste n’a pas changé.
- Payload des joueurs allégé.

## Tests effectués

- Vérification de syntaxe de `server.js` et `public/app.js`.
- Initialisation complète du DOM simulée sans erreur.
- Partie simulée avec 3 joueurs : création, entrée, cartes, tours, vote, résultat et synchronisation.
- Distribution des cartes mesurée à environ 64 ms sur le test local, sans attendre les images externes.
