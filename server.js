// server.js
// Backend do "Vira AI" — gera a foto personalizada do cliente (jogador de
// futebol, advogado, empresário etc.) usando a API de imagens da OpenAI.
//
// Fluxo (replica o wizard de 5 passos da página de vendas):
// 1) Foto      -> cliente sobe a foto
// 2) Versão    -> escolhe a categoria (jogador de futebol, advogado...)
// 3) Personalize -> cabelo, aparência, roupa, cenário, pose, acessórios,
//                    + campos específicos da categoria (ex: time/posição)
// 4) Revise    -> front-end mostra o resumo (não precisa do backend)
// 5) Finalize  -> chama /api/gerar-imagem, que monta o prompt e gera a imagem
//
// A chave da OpenAI fica só aqui no servidor (.env), nunca no navegador.

require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "[AVISO] OPENAI_API_KEY não encontrada. Copie .env.example para .env e coloque sua chave. " +
    "O servidor vai subir mesmo assim, mas gerar imagem vai falhar até a chave ser configurada."
  );
}

// ---------------------------------------------------------------------------
// Código de acesso — só quem comprou recebe (área de membros / e-mail da Cakto).
// Configure na Vercel: Settings > Environment Variables > CODIGO_ACESSO
// Pode ter mais de um, separado por vírgula (ex: "VIRA2026,PROMO10").
// Sem CODIGO_ACESSO configurado, a geração fica BLOQUEADA (pra não gastar
// crédito da OpenAI com quem não pagou).
// ---------------------------------------------------------------------------
const CODIGOS_ACESSO = (process.env.CODIGO_ACESSO || "")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

if (!CODIGOS_ACESSO.length) {
  console.warn("[AVISO] CODIGO_ACESSO não configurado. A geração de imagens fica bloqueada até configurar.");
}

function codigoValido(codigo) {
  if (!codigo || !CODIGOS_ACESSO.length) return false;
  const recebido = Buffer.from(String(codigo).trim().toUpperCase());
  return CODIGOS_ACESSO.some((certo) => {
    const esperado = Buffer.from(certo);
    return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
  });
}

// ---------------------------------------------------------------------------
// Acesso pelo E-MAIL DA COMPRA (recomendado).
// A Cakto avisa cada venda em /api/cakto-webhook; o app guarda o e-mail do
// comprador e o saldo de fotos no Upstash Redis (banco grátis da Vercel).
// Variáveis na Vercel (criadas sozinhas ao conectar o Upstash):
//   UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN
//   (ou KV_REST_API_URL e KV_REST_API_TOKEN)
// E uma que você cria: CAKTO_WEBHOOK_SECRET (a "chave secreta" do webhook na Cakto)
// Sem o banco configurado, o app continua funcionando só com CODIGO_ACESSO.
// O CODIGO_ACESSO continua valendo como chave do dono, para testes (sem limite).
// ---------------------------------------------------------------------------
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const BANCO_ATIVO = Boolean(REDIS_URL && REDIS_TOKEN);
const WEBHOOK_SECRET = (process.env.CAKTO_WEBHOOK_SECRET || "").trim();

// Quantas fotos cada plano dá (pelo preço da oferta na Cakto).
const PLANOS = [
  { minimo: 45, nome: "Ilimitado", fotos: null }, // null = sem limite
  { minimo: 25, nome: "Plus", fotos: 20 },
  { minimo: 15, nome: "Básico", fotos: 10 },
];
// Produtos abaixo de R$15 (order bump) com "qualidade" no nome liberam alta qualidade.
const BUMP_QUALIDADE = /qualidade|premium|hd/i;

if (!BANCO_ATIVO) console.warn("[AVISO] Banco (Upstash Redis) não configurado: acesso só por CODIGO_ACESSO.");

async function redis(...comando) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(comando),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) throw new Error(`Redis: ${json.error || r.status}`);
  return json.result;
}

function normalizarEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}
const chaveCliente = (email) => `cliente:${email}`;

async function lerCliente(email) {
  const lista = await redis("HGETALL", chaveCliente(email));
  if (!lista || !lista.length) return null;
  const c = {};
  for (let i = 0; i < lista.length; i += 2) c[lista[i]] = lista[i + 1];
  if (c.bloqueado === "1") return null;
  return {
    plano: c.plano || "Básico",
    ilimitado: c.ilimitado === "1",
    fotos: Number(c.fotos || 0),
    altaQualidade: c.hq === "1",
  };
}

// Tira 1 foto do saldo antes de gerar. Devolve o cliente atualizado ou null se acabou.
async function reservarFoto(email) {
  const cliente = await lerCliente(email);
  if (!cliente) return { ok: false, motivo: "nao_encontrado" };
  if (cliente.ilimitado) {
    await redis("HINCRBY", chaveCliente(email), "usadas", 1);
    return { ok: true, cliente };
  }
  const restante = await redis("HINCRBY", chaveCliente(email), "fotos", -1);
  if (restante < 0) {
    await redis("HINCRBY", chaveCliente(email), "fotos", 1);
    return { ok: false, motivo: "sem_saldo", cliente };
  }
  await redis("HINCRBY", chaveCliente(email), "usadas", 1);
  return { ok: true, cliente: { ...cliente, fotos: restante } };
}

// Se a geração falhar, devolve a foto pro cliente.
async function devolverFoto(email, cliente) {
  try {
    if (!cliente.ilimitado) await redis("HINCRBY", chaveCliente(email), "fotos", 1);
    await redis("HINCRBY", chaveCliente(email), "usadas", -1);
  } catch (e) {
    console.error("Falha ao devolver foto:", e);
  }
}

// Contato de suporte mostrado no rodapé (e-mail ou WhatsApp com DDD).
// Configure na Vercel: SUPORTE_CONTATO (ex: "suporte@viraai.com" ou "5571999999999")
const SUPORTE_CONTATO = (process.env.SUPORTE_CONTATO || "").trim() || null;

// Usa um valor provisório quando a chave não está configurada, só para o
// cliente da OpenAI não travar a inicialização do servidor. A checagem real
// acontece dentro da rota /api/gerar-imagem.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "chave-nao-configurada" });

// Aceita foto até 10MB, guardada em memória (não salva em disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.use(cors()); // em produção, troque por cors({ origin: "https://seudominio.com" })
app.use(express.json());
app.use(express.static("public"));

// ---------------------------------------------------------------------------
// Opções gerais — aparecem para QUALQUER categoria escolhida.
// ---------------------------------------------------------------------------
const CABELO = ["Meu cabelo atual", "Curto", "Médio", "Longo", "Fade", "Cacheado", "Crespo", "Liso", "Outro"];
const APARENCIA = ["Original", "Profissional", "Elegante", "Esportiva", "Casual", "Sofisticada"];

// ---------------------------------------------------------------------------
// Categorias ("Versão"). Cada uma tem:
//  - label/emoji: como aparece no card de escolha
//  - prompt: descrição-base da cena para a IA
//  - roupa / cenario / pose / acessorios: opções específicas dessa versão
//  - extra: um bloco de campos só dessa categoria (ex: Time/Posição no futebol)
// Para adicionar uma categoria nova, copie o formato de uma existente.
// ---------------------------------------------------------------------------
const CATEGORIAS = {
  futebol: {
    label: "Jogador de Futebol",
    emoji: "⚽",
    prompt:
      "Transforme a pessoa da foto em um(a) jogador(a) de futebol profissional, em pleno jogo ou em uma cena de estádio.",
    roupa: ["Uniforme clássico", "Uniforme moderno", "Roupa de treino", "Uniforme personalizado"],
    cenario: ["Estádio lotado", "Campo de treinamento", "Vestiário", "Entrada no campo", "Comemoração", "Entrevista", "Foto profissional"],
    pose: ["Comemorando", "Com a bola", "Correndo", "Olhando para a câmera", "Braços levantados", "Pose profissional"],
    acessorios: ["Nenhum", "Faixa", "Munhequeira", "Luvas", "Chuteiras em destaque"],
    extra: {
      titulo: "Detalhes de futebol",
      campos: [
        { nome: "time", label: "Time", opcoes: ["Time popular", "Outro time", "Sem time específico", "Uniforme personalizado"] },
        { nome: "posicao", label: "Posição", opcoes: ["Atacante", "Meio-campista", "Lateral", "Zagueiro", "Goleiro", "Sem posição específica"] },
      ],
    },
  },
  advogado: {
    label: "Advogado(a)",
    emoji: "⚖️",
    prompt:
      "Transforme a pessoa da foto em um(a) advogado(a) renomado(a), com postura confiante e traje jurídico.",
    roupa: ["Terno social", "Becas de audiência", "Traje formal escuro", "Look personalizado"],
    cenario: ["Escritório de advocacia", "Biblioteca jurídica", "Tribunal", "Sala de reunião", "Foto de perfil profissional"],
    pose: ["Braços cruzados", "Segurando uma pasta/processo", "Olhando para a câmera", "Sentado à mesa", "Pose profissional"],
    acessorios: ["Nenhum", "Óculos", "Relógio", "Caneta", "Pasta de documentos"],
    extra: {
      titulo: "Detalhes de advocacia",
      campos: [
        { nome: "area", label: "Área de atuação", opcoes: ["Direito empresarial", "Direito criminal", "Direito de família", "Direito trabalhista", "Sem área específica"] },
      ],
    },
  },
  empresario: {
    label: "Empresário(a)",
    emoji: "💼",
    prompt:
      "Transforme a pessoa da foto em um(a) empresário(a) de sucesso, com visual executivo de alto padrão.",
    roupa: ["Terno/tailleur clássico", "Look executivo moderno", "Casual premium", "Look personalizado"],
    cenario: ["Escritório moderno", "Vista para a cidade", "Sala de reuniões", "Evento corporativo", "Foto de perfil profissional"],
    pose: ["Braços cruzados", "Sentado(a) à mesa", "Olhando para a câmera", "Caminhando", "Pose profissional"],
    acessorios: ["Nenhum", "Óculos", "Relógio de luxo", "Notebook/tablet", "Caneta"],
    extra: {
      titulo: "Detalhes de negócios",
      campos: [
        { nome: "setor", label: "Setor", opcoes: ["Tecnologia", "Varejo", "Imóveis", "Finanças", "Sem setor específico"] },
      ],
    },
  },
  atleta: {
    label: "Atleta",
    emoji: "🏅",
    prompt:
      "Transforme a pessoa da foto em um(a) atleta de alta performance, em cena esportiva de destaque.",
    roupa: ["Uniforme de competição", "Roupa de treino", "Agasalho de equipe", "Look personalizado"],
    cenario: ["Pódio", "Pista/quadra de competição", "Academia", "Centro de treinamento", "Foto profissional"],
    pose: ["Comemorando vitória", "Em pleno movimento", "Olhando para a câmera", "Alongando", "Pose profissional"],
    acessorios: ["Nenhum", "Medalha", "Faixa na cabeça", "Luvas", "Garrafa de água"],
    extra: {
      titulo: "Detalhes esportivos",
      campos: [
        { nome: "modalidade", label: "Modalidade", opcoes: ["Corrida", "Natação", "Levantamento de peso", "Luta/artes marciais", "Sem modalidade específica"] },
      ],
    },
  },
  executivo: {
    label: "Executivo(a)",
    emoji: "👔",
    prompt:
      "Transforme a pessoa da foto em um(a) executivo(a) de alto escalão, visual sério e sofisticado.",
    roupa: ["Terno risca de giz", "Look executivo minimalista", "Traje formal escuro", "Look personalizado"],
    cenario: ["Sala da diretoria", "Arranha-céu ao fundo", "Aeroporto executivo", "Escritório de canto", "Foto de perfil profissional"],
    pose: ["Braços cruzados", "Olhando pela janela", "Sentado(a) à mesa", "Olhando para a câmera", "Pose profissional"],
    acessorios: ["Nenhum", "Óculos", "Relógio de luxo", "Maleta executiva", "Caneta"],
    extra: {
      titulo: "Detalhes executivos",
      campos: [
        { nome: "cargo", label: "Nível do cargo", opcoes: ["Diretor(a)", "CEO/Presidente", "Sócio(a)", "Gerente sênior", "Sem cargo específico"] },
      ],
    },
  },
  medico: {
    label: "Médico(a)",
    emoji: "🩺",
    prompt:
      "Transforme a pessoa da foto em um(a) médico(a) experiente, em ambiente clínico ou hospitalar.",
    roupa: ["Jaleco branco", "Scrub cirúrgico", "Traje social com jaleco", "Look personalizado"],
    cenario: ["Consultório", "Hospital", "Centro cirúrgico", "Corredor clínico", "Foto de perfil profissional"],
    pose: ["Braços cruzados", "Segurando prancheta", "Olhando para a câmera", "Examinando um exame/raio-x", "Pose profissional"],
    acessorios: ["Nenhum", "Estetoscópio", "Óculos", "Máscara cirúrgica", "Prancheta"],
    extra: {
      titulo: "Detalhes médicos",
      campos: [
        { nome: "especialidade", label: "Especialidade", opcoes: ["Cardiologia", "Pediatria", "Cirurgia", "Clínica geral", "Sem especialidade específica"] },
      ],
    },
  },
  modelo: {
    label: "Modelo",
    emoji: "📸",
    prompt:
      "Transforme a pessoa da foto em um(a) modelo profissional, em um ensaio fotográfico editorial.",
    roupa: ["Alta-costura", "Editorial minimalista", "Streetwear estiloso", "Look personalizado"],
    cenario: ["Estúdio fotográfico", "Passarela", "Cenário urbano", "Fundo colorido de estúdio", "Foto de perfil profissional"],
    pose: ["Pose editorial", "Caminhando na passarela", "Olhando para a câmera", "Pose dinâmica", "Pose profissional"],
    acessorios: ["Nenhum", "Óculos de sol", "Joias", "Chapéu", "Bolsa"],
    extra: {
      titulo: "Detalhes do ensaio",
      campos: [
        { nome: "tipoEnsaio", label: "Tipo de ensaio", opcoes: ["Editorial de moda", "Comercial/publicidade", "Preto e branco artístico", "Sem tipo específico"] },
      ],
    },
  },
  artista: {
    label: "Artista",
    emoji: "🎤",
    prompt:
      "Transforme a pessoa da foto em um(a) artista/músico(a) em cena de show ou sessão de fotos promocional.",
    roupa: ["Look de palco", "Estilo urbano/streetwear", "Traje elegante de evento", "Look personalizado"],
    cenario: ["Palco com luzes", "Show para multidão", "Estúdio de gravação", "Camarim", "Foto de capa de álbum"],
    pose: ["Cantando no microfone", "Tocando um instrumento", "Olhando para a câmera", "Interagindo com a plateia", "Pose profissional"],
    acessorios: ["Nenhum", "Microfone", "Óculos de sol", "Fone de ouvido", "Instrumento musical"],
    extra: {
      titulo: "Detalhes artísticos",
      campos: [
        { nome: "estiloMusical", label: "Estilo musical", opcoes: ["Pop", "Sertanejo", "Funk/rap", "Rock", "Sem estilo específico"] },
      ],
    },
  },
  criador: {
    label: "Criador de Conteúdo",
    emoji: "💻",
    prompt:
      "Transforme a pessoa da foto em um(a) criador(a) de conteúdo digital, em cena de gravação ou estúdio de mídia.",
    roupa: ["Casual estiloso", "Streetwear de marca", "Visual profissional de câmera", "Look personalizado"],
    cenario: ["Home studio", "Setup gamer/streaming", "Cenário com luz de anel", "Estúdio de podcast", "Foto de perfil profissional"],
    pose: ["Gravando com celular", "Falando para a câmera", "Olhando para a câmera", "Editando no computador", "Pose profissional"],
    acessorios: ["Nenhum", "Fone de ouvido", "Microfone de estúdio", "Anel de luz", "Câmera/celular"],
    extra: {
      titulo: "Detalhes de conteúdo",
      campos: [
        { nome: "plataforma", label: "Plataforma", opcoes: ["Instagram", "YouTube", "TikTok", "Twitch", "Sem plataforma específica"] },
      ],
    },
  },
  corretor: {
    label: "Corretor de Imóveis",
    emoji: "🏠",
    prompt:
      "Transforme a pessoa da foto em um(a) corretor(a) de imóveis profissional, em retrato de alto padrão que transmita confiança e credibilidade, como foto de perfil para redes sociais e anúncios de imóveis.",
    roupa: ["Terno", "Blazer", "Camisa social", "Social sem gravata", "Casual premium"],
    cenario: ["Imóvel de alto padrão", "Sala de estar decorada", "Fachada de casa moderna", "Escritório imobiliário", "Varanda com vista"],
    pose: ["Olhando para a câmera", "Em pé", "Braços cruzados", "Segurando chaves", "Pose profissional"],
    acessorios: ["Nenhum", "Óculos", "Relógio", "Chaves", "Tablet"],
    extra: {
      titulo: "Detalhes do imóvel",
      campos: [
        { nome: "tipoImovel", label: "Tipo de imóvel", opcoes: ["Apartamento", "Casa", "Cobertura", "Sem tipo específico"] },
      ],
    },
  },
  piloto: {
    label: "Piloto de Corrida",
    emoji: "🏎️",
    prompt:
      "Transforme a pessoa da foto em um(a) piloto de corrida profissional de monoposto, em cena de autódromo, com macacão de corrida e visual de competição de alto nível.",
    roupa: ["Macacão de corrida", "Macacão com capacete na mão", "Roupa de equipe (paddock)", "Look personalizado"],
    cenario: ["Grid de largada", "Box/pit stop", "Pódio com champanhe", "Paddock", "Pista ao pôr do sol"],
    pose: ["Ao lado do carro", "Dentro do cockpit", "Comemorando no pódio", "Olhando para a câmera", "Pose profissional"],
    acessorios: ["Nenhum", "Capacete", "Troféu", "Luvas de piloto", "Óculos escuros"],
    extra: {
      titulo: "Detalhes da corrida",
      campos: [
        { nome: "momento", label: "Momento", opcoes: ["Antes da largada", "Vitória", "Treino livre", "Sem momento específico"] },
      ],
    },
  },
  motociclista: {
    label: "Motociclista",
    emoji: "🏍️",
    prompt:
      "Transforme a pessoa da foto em um(a) motociclista estiloso(a), em cima de uma moto esportiva.",
    roupa: ["Jaqueta de couro", "Traje de motociclismo completo", "Visual casual streetwear", "Look personalizado"],
    cenario: ["Estrada ao entardecer", "Cidade à noite", "Garagem/oficina", "Estrada de montanha", "Foto de perfil profissional"],
    pose: ["Em cima da moto", "Encostado(a) na moto", "Olhando para a câmera", "Em movimento na estrada", "Pose profissional"],
    acessorios: ["Nenhum", "Capacete na mão", "Óculos escuros", "Luvas de couro", "Bota de motociclista"],
    extra: {
      titulo: "Detalhes da moto",
      campos: [
        { nome: "tipoMoto", label: "Tipo de moto", opcoes: ["Esportiva", "Custom/cruiser", "Naked", "Sem tipo específico"] },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// GET /api/config
// Devolve tudo que o front-end precisa para montar o wizard: categorias +
// opções gerais (cabelo, aparência) + opções específicas de cada categoria.
// ---------------------------------------------------------------------------
app.get("/api/config", (req, res) => {
  const categorias = Object.entries(CATEGORIAS).map(([chave, c]) => ({
    chave,
    label: c.label,
    emoji: c.emoji,
    roupa: c.roupa,
    cenario: c.cenario,
    pose: c.pose,
    acessorios: c.acessorios,
    extra: c.extra,
  }));

  res.json({ categorias, cabelo: CABELO, aparencia: APARENCIA, suporte: SUPORTE_CONTATO });
});

// ---------------------------------------------------------------------------
// POST /api/validar-codigo  { codigo: "..." }  ->  { valido: true/false }
// O front-end chama isso no passo 1, antes do cliente montar tudo.
// ---------------------------------------------------------------------------
app.post("/api/validar-codigo", (req, res) => {
  if (!CODIGOS_ACESSO.length) {
    return res.status(503).json({ valido: false, erro: "Acesso ainda não liberado. Fale com o suporte." });
  }
  const valido = codigoValido(req.body && req.body.codigo);
  return res.status(valido ? 200 : 401).json({
    valido,
    erro: valido ? undefined : "Código inválido. Confira o código que veio na sua compra.",
  });
});

// ---------------------------------------------------------------------------
// POST /api/entrar  { email }  ->  { valido, plano, fotos, ilimitado }
// O cliente entra com o e-mail que usou na compra.
// ---------------------------------------------------------------------------
app.post("/api/entrar", async (req, res) => {
  if (!BANCO_ATIVO) {
    return res.status(503).json({ valido: false, erro: "Acesso por e-mail ainda não liberado. Use o código da compra." });
  }
  const email = normalizarEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ valido: false, erro: "Digite um e-mail válido." });
  try {
    const cliente = await lerCliente(email);
    if (!cliente) {
      return res.status(401).json({
        valido: false,
        erro: "Não achamos uma compra com esse e-mail. Use o mesmo e-mail que você colocou no pagamento.",
      });
    }
    return res.json({ valido: true, plano: cliente.plano, fotos: cliente.fotos, ilimitado: cliente.ilimitado });
  } catch (e) {
    console.error("Erro ao entrar:", e);
    return res.status(500).json({ valido: false, erro: "Não deu pra verificar agora. Tente de novo em instantes." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cakto-webhook
// Configure na Cakto: Integrações > Webhooks > URL:
//   https://SEU-APP.vercel.app/api/cakto-webhook
// com os eventos "Compra aprovada", "Reembolso" e "Chargeback".
// ---------------------------------------------------------------------------
app.post("/api/cakto-webhook", async (req, res) => {
  if (!BANCO_ATIVO || !WEBHOOK_SECRET) {
    return res.status(503).json({ ok: false, erro: "Banco ou CAKTO_WEBHOOK_SECRET não configurado." });
  }
  const body = req.body || {};
  const recebido = Buffer.from(String(body.secret || ""));
  const esperado = Buffer.from(WEBHOOK_SECRET);
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) {
    return res.status(401).json({ ok: false });
  }

  const evento = String(body.event || "");
  const d = body.data || {};
  const email = normalizarEmail(d.customer && d.customer.email);
  if (!email) return res.json({ ok: true, ignorado: "sem e-mail" });
  const chave = chaveCliente(email);

  try {
    if (evento === "purchase_approved") {
      // Não conta a mesma venda duas vezes (a Cakto pode reenviar o aviso)
      const idVenda = String(d.id || d.refId || "");
      if (idVenda) {
        const nova = await redis("SET", `venda:${idVenda}`, "1", "NX", "EX", 60 * 60 * 24 * 90);
        if (nova !== "OK") return res.json({ ok: true, repetido: true });
      }

      const preco = Number((d.offer && d.offer.price) || d.amount || d.baseAmount || 0);
      const nomes = `${(d.product && d.product.name) || ""} ${(d.offer && d.offer.name) || ""}`;

      if (preco < 15 && BUMP_QUALIDADE.test(nomes)) {
        await redis("HSET", chave, "hq", "1");
        return res.json({ ok: true, tipo: "alta_qualidade" });
      }

      const plano = PLANOS.find((p) => preco >= p.minimo) || PLANOS[PLANOS.length - 1];
      await redis("HSET", chave, "plano", plano.nome, "bloqueado", "0", "nome", String((d.customer && d.customer.name) || ""));
      if (plano.fotos === null) await redis("HSET", chave, "ilimitado", "1");
      else await redis("HINCRBY", chave, "fotos", plano.fotos);
      return res.json({ ok: true, plano: plano.nome });
    }

    if (evento === "refund" || evento === "chargeback") {
      await redis("HSET", chave, "bloqueado", "1");
      return res.json({ ok: true, bloqueado: true });
    }

    return res.json({ ok: true, ignorado: evento });
  } catch (e) {
    console.error("Erro no webhook da Cakto:", e);
    return res.status(500).json({ ok: false });
  }
});

// Mantido por compatibilidade com integrações antigas
app.get("/api/categorias", (req, res) => {
  const lista = Object.entries(CATEGORIAS).map(([chave, v]) => ({ chave, label: v.label }));
  res.json(lista);
});

// ---------------------------------------------------------------------------
// POST /api/gerar-imagem
// Campos esperados (multipart/form-data):
//   foto        (arquivo, obrigatório)
//   categoria   (chave de CATEGORIAS, obrigatório)
//   cabelo, aparencia, roupa, cenario, pose, acessorios  (texto, opcionais)
//   extra       (JSON em string com os campos específicos da categoria, opcional)
//   detalhes    (texto livre opcional)
// ---------------------------------------------------------------------------
app.post("/api/gerar-imagem", upload.single("foto"), async (req, res) => {
  let reserva = null; // foto descontada do saldo do cliente (devolvida se der erro)
  let emailReservado = "";
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        erro: "O servidor ainda não tem a chave da OpenAI configurada (OPENAI_API_KEY no .env).",
      });
    }

    // Quem pode gerar: o dono (CODIGO_ACESSO, sem limite) ou um comprador
    // (e-mail da compra, com saldo de fotos).
    const ehDono = codigoValido(req.body.codigo);
    const emailCliente = !ehDono && BANCO_ATIVO ? normalizarEmail(req.body.email) : "";
    if (!ehDono && !emailCliente) {
      return res.status(401).json({
        erro: BANCO_ATIVO
          ? "Digite o e-mail que você usou na compra."
          : "Código de acesso inválido. Confira o código que veio na sua compra.",
        codigoInvalido: true,
      });
    }

    const { categoria, cabelo, aparencia, roupa, cenario, pose, acessorios, detalhes } = req.body;
    const arquivo = req.file;

    if (!arquivo) {
      return res.status(400).json({ erro: "Envie uma foto no campo 'foto'." });
    }
    if (!categoria || !CATEGORIAS[categoria]) {
      return res.status(400).json({
        erro: `Categoria inválida. Use uma destas: ${Object.keys(CATEGORIAS).join(", ")}`,
      });
    }

    const cat = CATEGORIAS[categoria];

    // Monta o prompt final combinando a cena-base + todas as escolhas do cliente
    const partes = [cat.prompt];

    if (cabelo && cabelo !== "Meu cabelo atual") partes.push(`Cabelo: ${cabelo}.`);
    if (aparencia && aparencia !== "Original") partes.push(`Aparência: ${aparencia}.`);
    if (roupa) partes.push(`Roupa: ${roupa}.`);
    if (cenario) partes.push(`Cenário: ${cenario}.`);
    if (pose) partes.push(`Pose: ${pose}.`);
    if (acessorios && acessorios !== "Nenhum") partes.push(`Acessórios: ${acessorios}.`);

    // Campos extras específicos da categoria (ex: time, posição, especialidade...)
    if (req.body.extra) {
      try {
        const extraObj = JSON.parse(req.body.extra);
        for (const [chaveCampo, valor] of Object.entries(extraObj)) {
          if (!valor || /^sem .* específic/i.test(valor)) continue;
          const campoDef = (cat.extra?.campos || []).find((c) => c.nome === chaveCampo);
          const rotulo = campoDef ? campoDef.label : chaveCampo;
          partes.push(`${rotulo}: ${valor}.`);
        }
      } catch (e) {
        // ignora JSON inválido em "extra" e segue sem esses detalhes
      }
    }

    if (detalhes && detalhes.trim()) {
      partes.push(`Detalhes adicionais pedidos pela pessoa: ${detalhes.trim()}.`);
    }

    partes.push(
      "Mantenha o rosto da pessoa da foto original bem reconhecível e fiel, com realismo fotográfico, sem parecer desenho ou cartoon.",
      "Não use logotipos, escudos, marcas, patrocinadores ou nomes de times, equipes e empresas reais."
    );

    const prompt = partes.join(" ");

    // Converte o buffer recebido em um "arquivo" que a lib da OpenAI aceita
    const imagemParaEnvio = await toFile(arquivo.buffer, arquivo.originalname || "foto.png", {
      type: arquivo.mimetype || "image/png",
    });

    // Modelo e qualidade podem ser trocados na Vercel sem mexer no código:
    //   OPENAI_IMAGE_MODEL   (padrão: gpt-image-2)
    //   OPENAI_IMAGE_QUALITY (padrão: medium — "low", "medium" ou "high")
    // O gpt-image-1 foi desligado pela OpenAI em 23/10/2026.
    // Desconta 1 foto do saldo do comprador antes de chamar a OpenAI
    if (emailCliente) {
      reserva = await reservarFoto(emailCliente);
      if (!reserva.ok) {
        const semSaldo = reserva.motivo === "sem_saldo";
        reserva = null;
        return res.status(semSaldo ? 402 : 401).json({
          erro: semSaldo
            ? "Suas fotos acabaram. Para criar mais, escolha um novo plano."
            : "Não achamos uma compra com esse e-mail. Use o mesmo e-mail do pagamento.",
          semSaldo,
          codigoInvalido: !semSaldo,
        });
      }
      emailReservado = emailCliente;
    }
    const altaQualidade = Boolean(reserva && reserva.cliente.altaQualidade);

    const resultado = await openai.images.edit({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      quality: altaQualidade ? "high" : process.env.OPENAI_IMAGE_QUALITY || "medium",
      image: imagemParaEnvio,
      prompt,
      size: "1024x1024",
    });

    const b64 = resultado.data[0].b64_json;

    const saldo = reserva
      ? { ilimitado: reserva.cliente.ilimitado, fotos: reserva.cliente.fotos }
      : null;
    reserva = null; // deu certo: a foto fica descontada

    return res.json({
      sucesso: true,
      saldo,
      categoria,
      prompt_usado: prompt,
      imagem_base64: b64, // front-end usa como: `data:image/png;base64,${imagem_base64}`
    });
  } catch (err) {
    console.error("Erro ao gerar imagem:", err);
    if (reserva && emailReservado) await devolverFoto(emailReservado, reserva.cliente);
    return res.status(500).json({
      erro: "Falha ao gerar a imagem. Tente novamente em instantes.",
      detalhe: process.env.NODE_ENV === "development" ? String(err.message || err) : undefined,
    });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Na Vercel, o próprio servidor deles chama esse arquivo como "função" —
// então NÃO chamamos app.listen() lá (senão dá erro). Só rodamos o
// app.listen() normal quando é você mesmo rodando "node server.js" ou
// "npm start" no seu computador/Render/Railway.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
