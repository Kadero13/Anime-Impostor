# Anime Imposteur V15

## Multijoueur et stabilité

- Reconnexion automatique par jeton propre à chaque onglet.
- Délai de grâce de 90 secondes avant de retirer un joueur déconnecté.
- Restauration de la room, de la carte, du tour, du vote et du résultat après reconnexion.
- Nettoyage contrôlé des rooms, minuteries et joueurs déconnectés.

## Jeu

- Modes Classique, Duo, Indice, Aveugle, Rapide, Chaos et Personnalisé.
- Réglages de room modifiables par l’hôte entre les manches.
- Expulsion d’un joueur, transfert du rôle d’hôte, ajout de temps et passage forcé à l’étape suivante.
- Roue de parole animée et bouton pour finir son tour immédiatement.
- Résultats détaillés : votes, cartes, imposteurs, classement et statistiques.

## Invitation et application

- Copie du code et du lien complet.
- QR code de la room.
- PWA installable avec manifeste et service worker.
- Logo, favicon et métadonnées sociales pour https://anime-impostor.onrender.com/.

## Performances

- Recherche et mise en cache des images uniquement côté serveur.
- Cache binaire d’images plafonné à 24 images et 24 Mo.
- Mode léger automatique avec plusieurs onglets ou un onglet masqué.
- Réduction des animations, filtres, intervalles, sons et éléments conservés dans le DOM.
