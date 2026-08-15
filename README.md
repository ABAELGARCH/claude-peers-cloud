# claude-peers-cloud

Fait communiquer **deux sessions Claude Code sur des machines différentes** comme deux ingénieurs en remote. Chaque session devient un "peer" visible par l'autre, avec son répertoire, sa branche git et un résumé de sa tâche. Tu envoies un message, l'autre Claude le reçoit instantanément.

```
 Claude A (Hamza, Mac 1)        Claude B (Frère, Mac 2)
  "peer xyz: check mon <message arrive instant>
   omni route config"   ───>    Claude B répond
```

Le broker tourne dans le cloud (Railway) au lieu de localhost. Authentification par token partagé.

## 1. Déployer le broker (une seule fois, sur Railway)

```bash
cd claude-peers-cloud
# crée un repo privé + pousse, puis déploie sur Railway
# Railway MCP: create project, set variables, deploy
```

Variables d'environnement Railway :

| Var | Valeur |
|-----|--------|
| `PORT` | `3000` |
| `CLAUDE_PEERS_TOKEN` | un secret que tu partages avec ton frère (ex: `openssl rand -hex 32`) |
| `CLAUDE_PEERS_DB` | laisse vide (défaut /tmp) |

Note le domaine généré, ex : `https://claude-peers-cloud.up.railway.app`

## 2. Configurer le MCP côté toi (et ton frère)

Sur **chaque** machine, créer/éditer `~/.claude.json` ou utiliser `.mcp.json` :

```json
{
  "mcpServers": {
    "claude-peers-cloud": {
      "command": "bun",
      "args": ["/chemin/vers/claude-peers-cloud/server.ts"],
      "env": {
        "CLAUDE_PEERS_BROKER_URL": "https://TON-BROKER.up.railway.app",
        "CLAUDE_PEERS_TOKEN": "TON_SECRET_PARTAGE",
        "CLAUDE_PEERS_OWNER": "hamza"
      }
    }
  }
}
```

Ton frère met `"CLAUDE_PEERS_OWNER": "brother"` (ou son prénom).

## 3. Lancer Claude Code avec le channel

```bash
claude --dangerously-load-development-channels server:claude-peers-cloud
```

## 4. Utiliser

> List all peers on the network

→ affiche l'autre session (owner, cwd, summary).

> Send a message to peer abc12345: "check mon omni route config, il me sort un 429"

→ l'autre Claude reçoit et répond.

## Sécurité
- Toutes les requêtes broker exigent `Authorization: Bearer <TOKEN>`.
- Le token est partagé uniquement entre toi et ton frère.
- Les peers inactifs > 2 min sont auto-supprimés.
- En mode dev (TOKEN vide), aucune auth — ne jamais faire ça en prod.
