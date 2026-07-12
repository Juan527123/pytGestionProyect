// api/chat.js
// Función serverless (Vercel la publica automáticamente en /api/chat).
// El navegador nunca ve la API key: solo este servidor la usa.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = "gemini-3.1-flash-lite"; // 500 solicitudes/día gratis en tu cuenta, muy por encima de otras opciones

// -----------------------------------------------------------------------
// Aquí va el "conocimiento" del bot. Edita este texto con la info curada
// de institutos, universidades, carreras y becas que ya tienes armada
// (por ejemplo, de tus charlas "Después del colegio"). Cuanto más
// específico y actualizado esté esto, mejores respuestas dará el bot.
// -----------------------------------------------------------------------
const SYSTEM_PROMPT = `
Eres el asistente virtual de "Después del Colegio", un proyecto de orientación
para estudiantes peruanos que están decidiendo qué hacer al terminar el colegio.

Tu único tema es: institutos técnicos, universidades (públicas y privadas) en
Perú, carreras profesionales y técnicas, procesos de admisión, y becas o
financiamiento educativo (Beca 18, Pronabec, crédito educativo, becas propias
de universidades e institutos, etc.).

Cómo respondes:
- Español de Perú, tono cercano y claro, como hablando con un estudiante de
  colegio o un egresado reciente recién salido. Nada de jerga innecesaria.
- Respuestas breves y directas primero; si el tema lo amerita, ofrece
  profundizar en vez de escribir un párrafo enorme de una.
- Al comparar opciones (instituto vs. universidad, carrera A vs. B, pública
  vs. privada), sé neutral: da ventajas y desventajas de cada una, no
  impongas una sola respuesta correcta.
- Para datos que cambian seguido (fechas de postulación, montos exactos de
  becas, requisitos), usa la búsqueda en Google que tienes disponible para
  verificar la info actual antes de responder. Si aun así no encuentras un
  dato confiable, no inventes cifras: da el panorama general y recomienda
  verificar en la fuente oficial (Pronabec, Sunedu, Minedu, o la página de
  la institución).
- Si preguntan algo fuera de este tema, redirige con amabilidad hacia tu
  propósito: ayudarles a decidir su camino después del colegio.
- No reemplazas a un asesor vocacional certificado ni das asesoría legal o
  financiera definitiva. Para decisiones grandes (firmar un contrato, pedir
  un préstamo educativo), sugiere revisarlo con un adulto de confianza.
`.trim();

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Vercel." });
    return;
  }

  const { message, previousInteractionId } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Falta el mensaje." });
    return;
  }
  if (message.length > 2000) {
    res.status(400).json({ error: "Mensaje demasiado largo." });
    return;
  }

  const payload = {
    model: MODEL,
    system_instruction: SYSTEM_PROMPT,
    input: message,
    generation_config: { temperature: 0.6 },
    tools: [{ type: "google_search" }],
  };
  if (previousInteractionId) {
    payload.previous_interaction_id = previousInteractionId;
  }

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": "2026-05-20",
      },
      body: JSON.stringify(payload),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", geminiRes.status, errText);
      if (geminiRes.status === 429) {
        res.status(429).json({
          error: "Muchas personas usando el bot ahora mismo. Intenta en un momento.",
        });
        return;
      }
      res.status(502).json({ error: "El bot no pudo responder. Intenta de nuevo." });
      return;
    }

    const data = await geminiRes.json();
    const text = extractText(data);
    const sources = extractSources(data);

    res.status(200).json({
      text: text || "No pude generar una respuesta, intenta reformular tu pregunta.",
      interactionId: data.id,
      sources,
    });
  } catch (err) {
    console.error("Error llamando a Gemini:", err);
    res.status(500).json({ error: "Error de conexión con el bot." });
  }
};

// La respuesta de la API viene como una lista de "steps" (pasos), no como
// un solo texto plano. Buscamos el último paso de tipo "model_output" y
// juntamos sus bloques de texto.
function extractText(data) {
  if (!data || !Array.isArray(data.steps)) return "";
  const outputSteps = data.steps.filter((s) => s.type === "model_output");
  const lastOutput = outputSteps[outputSteps.length - 1];
  if (!lastOutput || !Array.isArray(lastOutput.content)) return "";
  return lastOutput.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// Cuando el bot busca en Google, el texto de la respuesta trae "annotations"
// con los links de las páginas que usó. Los juntamos y quitamos duplicados.
function extractSources(data) {
  if (!data || !Array.isArray(data.steps)) return [];
  const outputSteps = data.steps.filter((s) => s.type === "model_output");
  const lastOutput = outputSteps[outputSteps.length - 1];
  if (!lastOutput || !Array.isArray(lastOutput.content)) return [];

  const seen = new Set();
  const sources = [];
  for (const block of lastOutput.content) {
    if (!Array.isArray(block.annotations)) continue;
    for (const a of block.annotations) {
      if (a.uri && !seen.has(a.uri)) {
        seen.add(a.uri);
        sources.push({ uri: a.uri, title: a.title || a.uri });
      }
    }
  }
  return sources;
}
