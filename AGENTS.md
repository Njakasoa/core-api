# AGENTS.md — core-api

## Deploy

Le VPS auto-déploie ce dépôt via le timer systemd `core-api-update.timer` (environ chaque minute).
Le service lance `deploy/update-core-api.sh`, fetch `origin/main`, fast-forward le checkout, rebuild
l'image Docker locale et recrée le service `core-api` après validation Compose.

Pour vérifier l'état du déploiement, préférer les commandes systemd plutôt qu'un fetch manuel inutile :

```bash
systemctl status core-api-update.timer core-api-update.service
journalctl -u core-api-update.service -n 100 --no-pager
```

Si une vérification Git est nécessaire, utiliser la configuration de remote existante du repo. Le dépôt
`ai-server-personal` est différent : son fetch manuel doit utiliser la clé `/opt/stacks/.ssh/ai-server_deploy_key`.
