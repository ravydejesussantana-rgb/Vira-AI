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

  res.json({ categorias, cabelo: CABELO, aparencia: APARENCIA });
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
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        erro: "O servidor ainda não tem a chave da OpenAI configurada (OPENAI_API_KEY no .env).",
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
      "Mantenha o rosto da pessoa da foto original bem reconhecível e fiel, com realismo fotográfico, sem parecer desenho ou cartoon."
    );

    const prompt = partes.join(" ");

    // Converte o buffer recebido em um "arquivo" que a lib da OpenAI aceita
    const imagemParaEnvio = await toFile(arquivo.buffer, arquivo.originalname || "foto.png", {
      type: arquivo.mimetype || "image/png",
    });

    const resultado = await openai.images.edit({
      model: "gpt-image-1",
      image: imagemParaEnvio,
      prompt,
      size: "1024x1024",
    });

    const b64 = resultado.data[0].b64_json;

    return res.json({
      sucesso: true,
      categoria,
      prompt_usado: prompt,
      imagem_base64: b64, // front-end usa como: `data:image/png;base64,${imagem_base64}`
    });
  } catch (err) {
    console.error("Erro ao gerar imagem:", err);
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
