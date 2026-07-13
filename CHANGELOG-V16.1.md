# Anime Imposteur V16.1 — Correction du résultat de vote

## Bug corrigé

Lorsqu’un joueur non imposteur recevait le plus de votes, l’écran pouvait afficher « personne n’a été éliminé » alors que la victoire était correctement donnée à l’imposteur.

## Changements

- Sauvegarde du nom, de la carte, de l’univers et du rôle de chaque participant au début de la manche.
- L’élimination dépend maintenant du jeton réellement voté, et non de la présence actuelle du joueur dans la room.
- Affichage dédié du joueur éliminé et de sa carte sur l’écran final.
- Conservation du détail des votes même après la déconnexion d’un joueur.
- Conservation de tous les participants dans le classement final.
- Nouveau cache du service worker afin que le correctif soit chargé après le déploiement.
- Version serveur : 16.1.0.
