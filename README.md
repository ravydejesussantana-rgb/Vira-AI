# Vira AI — Gerador de Foto Personalizada

Backend + tela completa em formato de wizard (5 passos: Foto → Versão →
Personalize → Revise → Finalize), que recebe a foto do cliente e todas as
escolhas de personalização, e usa a API de imagens da OpenAI para gerar a foto
final, mantendo o rosto da pessoa.

## O que já vem pronto

- `server.js` — o backend (Node + Express)
- `public/index.html` — a tela que o cliente usa de verdade (já com a
  identidade visual do Vira AI: preto + verde-limão)
- 10 categorias já configuradas, cada uma com roupa/cenário/pose/acessórios
  próprios + um bloco de detalhes específico: Jogador de Futebol, Advogado(a),
  Empresário(a), Atleta, Executivo(a), Médico(a), Modelo, Artista, Criador de
  Conteúdo e Motociclista
- Opções gerais de Cabelo e Aparência, iguais para qualquer categoria

## Como rodar (primeira vez)

1. Instale o [Node.js](https://nodejs.org/) (versão 18 ou mais recente) se
   ainda não tiver.
2. Nesta pasta, rode no terminal:
   ```
   npm install
   ```
3. Copie o arquivo `.env.example` para `.env`:
   ```
   cp .env.example .env
   ```
4. Abra o `.env` e coloque sua chave da OpenAI (pega em
   https://platform.openai.com/api-keys):
   ```
   OPENAI_API_KEY=sk-....
   ```
5. Rode o servidor:
   ```
   npm start
   ```
6. Abra `http://localhost:3000` no navegador — vai aparecer a página de teste.

## Como colocar no ar (pra usar de verdade)

Esse backend precisa ficar hospedado em algum lugar que rode Node.js. Opções
fáceis e com plano gratuito/barato:

- **Render** (render.com) — mais simples pra começar
- **Railway** (railway.app)
- **Fly.io**

Em qualquer uma dessas, o processo é parecido:
1. Suba esses arquivos num repositório do GitHub (ou faça upload direto,
   depende da plataforma).
2. Crie um novo serviço apontando pra esse repositório.
3. Nas configurações do serviço, adicione a variável de ambiente
   `OPENAI_API_KEY` com sua chave (nunca coloque a chave direto no código).
4. A plataforma vai rodar `npm install` e depois `npm start` sozinha.
5. Você recebe uma URL pública (ex: `https://vira-ae-foto.onrender.com`).

## Como integrar na sua página de vendas / área de membros

O botão "Criar minha foto" da sua página deve levar direto pra URL onde esse
`public/index.html` está publicado (ex: `https://seu-backend.onrender.com/`).
Ele já é a tela completa — não precisa reconstruir nada.

O `index.html` conversa com dois endpoints:

**`GET /api/config`** — devolve todas as categorias e opções (cabelo,
aparência, roupa, cenário, pose, acessórios, campos extras por categoria). O
front-end usa isso pra montar os passos 2 e 3 automaticamente.

**`POST /api/gerar-imagem`** — recebe a foto + todas as escolhas:

```
Content-Type: multipart/form-data

Campos:
- foto        (arquivo da imagem)
- categoria   (chave, ex: "futebol")
- cabelo, aparencia, roupa, cenario, pose, acessorios  (texto)
- extra       (JSON em string com os campos específicos da categoria,
                ex: {"time":"Sem time específico","posicao":"Atacante"})
- detalhes    (texto livre, opcional)
```

Resposta:
```json
{
  "sucesso": true,
  "categoria": "futebol",
  "prompt_usado": "...",
  "imagem_base64": "......"
}
```

Você mostra a imagem no navegador assim:
```html
<img src="data:image/png;base64,SEU_BASE64_AQUI" />
```

## Adicionando ou ajustando categorias

Abra `server.js` e procure o objeto `CATEGORIAS`. Cada categoria segue este formato:

```js
minhaCategoria: {
  label: "Nome que aparece pro cliente",
  emoji: "🎯",
  prompt: "Descrição-base da cena para a IA...",
  roupa: ["Opção 1", "Opção 2", "..."],
  cenario: ["Opção 1", "Opção 2", "..."],
  pose: ["Opção 1", "Opção 2", "..."],
  acessorios: ["Nenhum", "Opção 2", "..."],
  extra: {
    titulo: "Detalhes específicos dessa categoria",
    campos: [
      { nome: "chaveInterna", label: "Nome do campo", opcoes: ["Opção 1", "Opção 2", "Sem ... específico"] },
    ],
  },
},
```

Só copiar esse formato, trocar os textos, e a categoria já aparece
automaticamente no wizard (que busca tudo em `/api/config`) — não precisa
mexer no `index.html`.

## Sobre custo e velocidade

- Cada imagem gerada pelo `gpt-image-1` tem um custo por chamada na OpenAI
  (consulte a página de preços da OpenAI para o valor atual).
- Geração leva entre ~15 e 40 segundos — vale colocar uma mensagem de
  "carregando" na sua página de verdade (a página de teste já faz isso).
- Para evitar gente abusando (gerando várias imagens de graça, testando sem
  pagar), o ideal é essa página de geração só ficar acessível *depois* do
  pagamento aprovado — por exemplo, dentro da área de membros da Cakto, ou
  numa URL que só é revelada no e-mail de confirmação de compra.

## Segurança

- A chave da OpenAI (`OPENAI_API_KEY`) fica só no servidor, nunca aparece pro
  navegador do cliente.
- Nunca suba o arquivo `.env` (com a chave de verdade) pro GitHub — se usar
  Git, já existe um `.gitignore` de exemplo abaixo que você pode criar.
