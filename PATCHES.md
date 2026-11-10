# Evolution API 2.3.7 corrigida: instância `open` que para de receber

Branch `fix/recebimento-baileys-rc14`, a partir da tag oficial `2.3.7` de
`evolution-foundation/evolution-api`.

**Sintoma tratado:** a instância aparece `open`, envia normalmente, mas para de
receber mensagens (nenhum `messages.upsert`, nada gravado). `/instance/restart`
e restart do container não resolvem; só um novo QR resolve, por algumas horas.

## Base escolhida

Tag oficial **2.3.7** com patches pontuais, em vez do fork não oficial citado na
issue [#2745](https://github.com/evolution-foundation/evolution-api/issues/2745)
(`AlmogCohen/evolution-api`, Baileys rc14).

- O fork tem cerca de 70 mudanças, várias delas em contratos que o CRM usa:
  payloads de `contacts.upsert` e `chats.*`, logout que passa a responder
  `202 PENDING`, novo evento `messages.undecryptable`, mensagens de erro de mídia.
  Trocar tudo de uma vez aumenta o risco sem atacar a causa.
- O fork **não** traz o ack de `<status>` (a causa da issue #2778, que bate
  exatamente com o sintoma daqui) nem os pedidos repetidos de `offline_batch`.
- Ele serviu de referência: cache da foto de perfil por contato e o pin no rc14.

## O que mudou e por quê

### 1. Baileys `7.0.0-rc.9` → `7.0.0-rc14`

`package.json`: `"baileys": "7.0.0-rc14"`.

- Corrige o deadlock do rc.9 no processamento de mensagens recebidas (corrigido
  no rc10).
- O rc.9 está na faixa afetada do CVE-2026-48063 (GHSA-qvv5-jq5g-4cgg),
  segundo a issue #2745.
- `overrides: { "whatsapp-rust-bridge": "0.5.5" }`: o rc14 depende da `0.5.4`,
  cujo `exports` só tem `import`; o Evolution é CommonJS e daria
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. A `0.5.5` acrescenta `require`. É o mesmo
  override que o branch `develop` oficial usa.
- O código do Evolution 2.3.7 compila sem mudanças contra o rc14
  (`tsc --noEmit` limpo).
- As sessões abertas no rc.9 abrem no rc13/rc14 sem novo QR (relatado no
  diagnóstico e na issue #2745). **O caminho inverso não foi testado**; veja
  [Rollback](#rollback).

### 2. Patches no Baileys (`patches/baileys+7.0.0-rc14.patch`)

Aplicados pelo `patch-package` no `postinstall` (`patch-package --error-on-fail`):
se o patch não aplicar, `npm ci`/`npm install` falham, inclusive no build do
Docker. Todo trecho alterado leva o comentário `[evolution-patched]`.

| Arquivo | Mudança | Motivo |
|---|---|---|
| `lib/Socket/messages-recv.js` | `handleStatus` faz ack de stanzas `<status>`; `CB:status` passa por `processNode`; `status` entra no mapa da fila offline | Issue [#2778](https://github.com/evolution-foundation/evolution-api/issues/2778) / PR [#2785](https://github.com/evolution-foundation/evolution-api/pull/2785), backport de WhiskeySockets/Baileys#2883. Sem o ack, o servidor segura as mensagens novas e derruba o stream ~50 min depois com `ack class="status"`. É o sintoma daqui: restart não resolve, QR resolve por algumas horas |
| `lib/Socket/socket.js` | Depois do primeiro `<offline_batch count="100">`, pede outro lote quando passam 3 s sem item offline, até chegar `<ib><offline>`. Só age depois de um `<offline_preview>`, com limite de 200 pedidos, e para quando o socket fecha | Bug 3 do diagnóstico (WhiskeySockets/Baileys#2810): o original pede um lote só, e um aparelho com mais de 100 itens pendentes nunca termina o sync offline |
| `lib/Socket/chats.js` | `profilePictureUrl` deixa de anexar `<tctoken>` (comportamento do rc.9). `BAILEYS_PROFILE_PIC_TCTOKEN=true` religa | Bug 2: para parte dos contatos o servidor nunca responde a consulta com tctoken, e cada uma espera 60 s |

Conferido no código real do rc14: os trechos e números de linha batem com o
diagnóstico (chats.js ~564, socket.js ~805, messages-recv.js ~1579/1621).

**Não aplicado:** o "descartar backlog antigo" opcional do diagnóstico. Ele
confirma e joga fora mensagens que o CRM nunca receberia.

### 3. Foto de perfil fora do caminho crítico (Evolution)

`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` e
`src/utils/profilePictureCache.ts`.

O `messages.upsert` fazia `await this.profilePicture(remoteJid)` para cada
mensagem, dentro da fila serial de eventos da instância
(`eventProcessingQueue`), sem timeout. Uma consulta presa travava todo o
recebimento por 60 s.

- Toda consulta de foto agora tem timeout: `PROFILE_PICTURE_TIMEOUT_MS`,
  padrão 5000.
- `messages.upsert` e `contacts.upsert` usam um cache por JID: 10 min para
  resultados, 1 min para falhas (timeout, conexão fechada), no máximo 5000
  JIDs. Consultas simultâneas ao mesmo JID são compartilhadas, e uma consulta
  antiga que termina depois de um refresh não sobrescreve o resultado novo.
- `contacts.update` refaz a consulta quando o WhatsApp avisa que a foto mudou
  ou foi removida (`imgUrl` presente) e atualiza o cache. Nos outros casos usa
  o cache.
- `POST /chat/fetchProfilePictureUrl/{instance}` (usado pelo CRM) **não** usa
  cache. Só ganhou o timeout, e a resposta mantém o formato
  `{ wuid, profilePictureUrl }`.

Variáveis opcionais (os padrões já servem):

| Variável | Padrão | Efeito |
|---|---|---|
| `PROFILE_PICTURE_TIMEOUT_MS` | `5000` | Timeout de cada consulta de foto |
| `PROFILE_PICTURE_CACHE_TTL_SECONDS` | `600` | Validade do cache; `0` desliga o cache |
| `PROFILE_PICTURE_CACHE_FAILURE_TTL_SECONDS` | `60` | Validade de uma falha no cache |
| `PROFILE_PICTURE_CACHE_MAX_ENTRIES` | `5000` | Limite de JIDs no cache por instância |
| `BAILEYS_PROFILE_PIC_TCTOKEN` | (vazio) | `true` volta a mandar `<tctoken>` na consulta de foto |
| `BAILEYS_OFFLINE_BATCH_IDLE_MS` | `3000` | Tempo sem item offline antes de pedir o próximo lote |

### 4. Build e testes

- `Dockerfile`: `COPY ./patches ./patches` antes do `npm ci`, para o
  `postinstall` aplicar o patch dentro da imagem.
- `npm test` = `node --import tsx --test`. O script antigo apontava para
  `test/all.test.ts`, que não existe.
- `.gitignore`: a pasta `/test/` era ignorada inteira; agora só os
  `*.test.ts`/`*.test.mjs` são versionados.
- `test/baileys-patches.test.mjs`: monta um socket Baileys real sobre um
  WebSocket falso (sem rede), injeta stanzas do servidor e decodifica o que o
  cliente envia. Cobre: pedidos repetidos de `offline_batch` (e nenhum pedido
  extra enquanto os itens chegam, sem `<offline_preview>`, depois de
  `<ib><offline>` ou com o socket fechado), ack de `<status>` online e offline, e consulta de foto sem
  `<tctoken>` (com o controle `BAILEYS_PROFILE_PIC_TCTOKEN=true`). Com o patch
  revertido (`npx patch-package --reverse`), os 4 testes de comportamento
  falham; os outros 3 são controles.
- `test/profilePictureCache.test.ts`: TTL, falha cacheada e TTL próprio para
  falhas, "sem foto" diferente de "falhou", deduplicação, refresh vencendo
  consulta antiga, limite de entradas e TTL 0.
- As variáveis novas estão documentadas, comentadas, no `.env.example`.

## Contratos usados pelo CRM: o que não mudou

Rotas `/message/sendText|sendMedia|sendWhatsAppAudio`,
`/instance/connectionState|restart|connect`, `/chat/findMessages`,
`/chat/getBase64FromMediaMessage`, `/chat/fetchProfilePictureUrl` e
`/webhook/set`, e os webhooks `messages.upsert` (com `key.remoteJidAlt`),
`messages.update` e `connection.update`: nenhuma linha de código dessas rotas ou
desses payloads mudou. A única diferença visível é que, no webhook
`contacts.update` disparado pelo recebimento, `profilePicUrl` pode vir do cache
(até 10 min).

## Como publicar no EasyPanel

> Antes de qualquer coisa: **backup da sessão** da instância (o volume
> `/evolution/instances` e/ou a tabela `Session` do banco da Evolution, conforme
> onde a sessão é guardada) e do banco da Evolution. Publique num horário
> calmo.

**Atenção ao backlog.** Assim que a versão corrigida subir, o WhatsApp entrega
de uma vez o que ficou retido (relatos na #2778: ~17 h de mensagens em ~6 min).
Tudo vira `messages.upsert` e passa pelo CRM e pelo agente do n8n. Se o agente
responder sozinho, ele pode mandar respostas fora de hora para mensagens
antigas. Considere pausar o agente nos primeiros minutos, ou garantir que ele
ignore mensagens com `messageTimestamp` antigo.

**Atenção ao restart.** Reiniciar o processo descarta a fila em memória do
Evolution: mensagens já confirmadas ao WhatsApp mas ainda não processadas se
perdem e não são reentregues. Evite reiniciar no meio de uma rajada. O sync do
CRM (`findMessages`) cobre parte disso.

### Opção A: fork no GitHub + build pelo Dockerfile (mais simples)

1. Crie um fork de `evolution-foundation/evolution-api` na sua conta (ou um
   repositório privado) e envie o branch `fix/recebimento-baileys-rc14`.
2. No EasyPanel, no serviço da Evolution: **Source → GitHub**, repositório do
   fork, branch `fix/recebimento-baileys-rc14`, **Build → Dockerfile**
   (`Dockerfile` na raiz).
3. Mantenha **as mesmas** variáveis de ambiente, volumes e domínio do serviço
   atual. Para a validação inicial, mude só `LOG_BAILEYS=info`.
4. Deploy. O build roda na VPS (`npm ci` + `tsc` + `tsup`) e precisa de
   aproximadamente 2 GB de RAM livres.

### Opção B: imagem própria num registry

```bash
docker build -t ghcr.io/<usuario>/evolution-api:2.3.7-rc14-patched .
docker push ghcr.io/<usuario>/evolution-api:2.3.7-rc14-patched
```

No EasyPanel: **Source → Docker Image** →
`ghcr.io/<usuario>/evolution-api:2.3.7-rc14-patched` (com credencial do registry
se for privado). Mesmas variáveis e volumes.

## Rollback

1. No EasyPanel, volte a **Source → Docker Image** →
   `evoapicloud/evolution-api:v2.3.7` e faça o deploy (mesmas variáveis e
   volumes).
2. Se a instância não reconectar (sessão gravada pelo rc14 lida pelo rc.9, um
   caminho **não testado**), restaure o backup da sessão feito antes do deploy.
   Se não houver backup, desconecte e leia o QR de novo.
3. Nenhuma migração de banco foi adicionada: `prisma/` está igual ao da 2.3.7.

## Como validar depois do deploy

1. **Patch presente na imagem:**
   `grep -c evolution-patched node_modules/baileys/lib/Socket/socket.js` no
   console do container deve dar `1` ou mais.
2. **Sync offline completo** (`LOG_BAILEYS=info`): depois de conectar, o log
   deve mostrar `offline preview received`, possivelmente alguns
   `no offline item for a while, requesting next offline batch`, e por fim
   `handled N offline messages/notifications`. Se `handled N offline` nunca
   aparecer, o bug 3 continua.
3. **Sem queda por `<status>`:** por mais de 1 h, não deve aparecer
   `stream errored out` com `reasonNode` `{"tag":"ack","attrs":{"class":"status"}}`
   (antes, um a cada ~50 min). Com `LOG_BAILEYS=debug` aparecem linhas `sent ack`
   com `recv.tag: "status"`.
4. **Foto de perfil rápida:** cronometre alguns remetentes recentes:
   ```bash
   curl -s -o /dev/null -w '%{time_total}\n' -X POST \
     "$EVOLUTION_URL/chat/fetchProfilePictureUrl/<instancia>" \
     -H "apikey: $EVOLUTION_APIKEY" -H 'Content-Type: application/json' \
     -d '{"number":"55DDDNUMERO"}'
   ```
   O esperado é menos de 1 s e nunca mais de ~5 s. Uma resposta de ~60 s
   significa que o patch do tctoken não está ativo.
5. **Recebimento:** mande mensagens de 2 ou 3 contatos diferentes e confira o
   `messages.upsert` no CRM em segundos. Acompanhe por algumas horas,
   principalmente na janela em que a instância costumava "ficar surda".
6. Depois de alguns dias estável, volte `LOG_BAILEYS` para `error`.

## Quando remover os patches

- Ack de `<status>`: quando um Baileys publicado incluir WhiskeySockets/Baileys#2883.
- `offline_batch`: quando WhiskeySockets/Baileys#2810 for corrigido.
- tctoken na foto: quando o Baileys tratar a falta de resposta, ou mantenha
  desligado.

Ao subir o Baileys, `patch-package` falha o build se o patch não aplicar.
Recrie o patch para a nova versão com `npx patch-package baileys` e rode
`npm test`.
