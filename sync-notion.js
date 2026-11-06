const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
const SITE_BASE_URL = (process.env.SITE_BASE_URL || "https://psyhako.github.io/arrrifhcks-site").replace(/\/$/, "");
const NOTION_VERSION = "2025-09-03";

if (!NOTION_TOKEN) throw new Error("Не задан GitHub Secret NOTION_TOKEN.");
if (!DATA_SOURCE_ID) throw new Error("Не задан NOTION_DATA_SOURCE_ID.");

function readSofasFromHtml() {
  const htmlPath = path.join(process.cwd(), "index.html");
  if (!fs.existsSync(htmlPath)) throw new Error("Не найден index.html в корне репозитория.");

  const html = fs.readFileSync(htmlPath, "utf8");
  const match = html.match(/const\s+SOFAS\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match) throw new Error("Не удалось найти массив const SOFAS = [...] в index.html.");

  const sofas = vm.runInNewContext(match[1], Object.create(null), { timeout: 1000 });
  if (!Array.isArray(sofas)) throw new Error("SOFAS должен быть массивом.");
  return sofas;
}

function cleanName(rawName) {
  const name = String(rawName || "").trim();
  const quoted = name.match(/^Модель\s*[«"](.+?)[»"]$/i);
  return quoted ? quoted[1].trim() : name;
}

function parsePrice(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  const price = Number(digits);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Не удалось распознать цену: "${value}"`);
  }
  return price;
}

function parseDimensions(value) {
  const match = String(value || "").match(/(\d+(?:[.,]\d+)?)\s*[×xх]\s*(\d+(?:[.,]\d+)?)/i);
  if (!match) throw new Error(`Не удалось распознать размеры: "${value}"`);
  return {
    length: Number(match[1].replace(",", ".")),
    width: Number(match[2].replace(",", ".")),
  };
}

function photoUrl(photoPath) {
  const clean = String(photoPath || "").replace(/^\/+/, "");
  return clean ? `${SITE_BASE_URL}/${clean.split("/").map(encodeURIComponent).join("/")}` : null;
}

function buildProperties(sofa) {
  const name = cleanName(sofa.name);
  if (!name) throw new Error("У одной из моделей отсутствует name.");

  const installmentPrice = parsePrice(sofa.price);
  const fullPrice = installmentPrice - 5000;
  if (fullPrice <= 0) throw new Error(`Цена полной оплаты для ${name} получилась некорректной.`);

  const dimensions = parseDimensions(sofa.size);
  const properties = {
    "Название": { title: [{ text: { content: name } }] },
    "Стоимость": { number: installmentPrice },
    "Цена в рассрочку": { number: installmentPrice },
    "Цена при полной оплате": { number: fullPrice },
    "Длина, см": { number: dimensions.length },
    "Ширина, см": { number: dimensions.width },
    "Наличие": {
      multi_select: sofa.status === "stock"
        ? [{ name: "В наличии" }, { name: "Под заказ" }]
        : sofa.status === "order"
          ? [{ name: "Под заказ" }]
          : [],
    },
  };

  // Не затираем вручную заполненные свойства, если сайт пока не содержит этих данных.
  if (String(sofa.fabric || "").trim()) {
    properties["Материал обивки"] = {
      rich_text: [{ type: "text", text: { content: String(sofa.fabric).trim() } }],
    };
  }

  const image = photoUrl(sofa.photo);
  if (image) {
    properties["Фото"] = {
      files: [{
        name: path.basename(String(sofa.photo)),
        type: "external",
        external: { url: image },
      }],
    };
  }

  return { name, properties };
}

async function notionRequest(endpoint, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const bodyText = await response.text();
  let body;
  try { body = bodyText ? JSON.parse(bodyText) : {}; }
  catch { body = { raw: bodyText }; }

  if (!response.ok) {
    throw new Error(`Notion API ${response.status}: ${body.message || bodyText}`);
  }
  return body;
}

async function getAllPages() {
  const pages = [];
  let cursor;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const result = await notionRequest(
      `/data_sources/${DATA_SOURCE_ID}/query`,
      { method: "POST", body: JSON.stringify(body) }
    );

    pages.push(...(result.results || []));
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);

  return pages;
}

function getPageTitle(page) {
  const titleProperty = page.properties?.["Название"];
  return (titleProperty?.title || []).map(part => part.plain_text || part.text?.content || "").join("").trim();
}

async function main() {
  const sofas = readSofasFromHtml();
  if (sofas.length === 0) {
    console.log("В SOFAS нет моделей. Каталог Notion не изменён.");
    return;
  }

  const prepared = sofas.map(buildProperties);
  const existingPages = await getAllPages();
  const byTitle = new Map();

  for (const page of existingPages) {
    const title = getPageTitle(page);
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(page);
  }

  let created = 0;
  let updated = 0;

  for (const sofa of prepared) {
    const matches = byTitle.get(sofa.name) || [];

    if (matches.length > 1) {
      console.warn(`В Notion уже есть дубликаты "${sofa.name}". Обновляю первую запись; остальные не удаляю.`);
    }

    if (matches.length > 0) {
      const page = matches[0];
      await notionRequest(`/pages/${page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: sofa.properties }),
      });
      updated++;
      console.log(`Обновлено: ${sofa.name}`);
    } else {
      await notionRequest("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
          properties: sofa.properties,
        }),
      });
      created++;
      console.log(`Добавлено: ${sofa.name}`);
    }
  }

  console.log(`Синхронизация завершена. Добавлено: ${created}; обновлено: ${updated}.`);
  console.log("Записи Notion, которых больше нет в SOFAS, автоматически не удаляются.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
