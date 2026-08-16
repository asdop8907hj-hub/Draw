const RS = 660;

// 如果 index.html 和 Worker 是同一个域名，保持空字符串。
// 如果 index.html 在 draw-1g3.pages.dev，而 Worker 是另一个域名，
// 需要把这里改成你的 Worker URL，例如：
// const API_ORIGIN = "https://your-worker.workers.dev";
const API_ORIGIN = "";

const HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: HEADERS,
  });
}

function getRound() {
  return Math.floor(Date.now() / (RS * 1000));
}

function roundStart(round: number) {
  return round * RS * 1000;
}

async function sha256hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(hash))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function fair4(seed: string) {
  const M = 2n ** 256n;
  const T = 10000n;
  const rem = M % T;

  let hex = await sha256hex(seed);
  let big = BigInt("0x" + hex);

  while (big >= M - rem) {
    hex = await sha256hex(hex);
    big = BigInt("0x" + hex);
  }

  return String(big % T).padStart(4, "0");
}

async function getBTC() {
  const r = await fetch(
    "https://mempool.space/api/blocks/tip/hash",
    {
      headers: {
        "Accept": "text/plain",
      },
    }
  );

  if (!r.ok) {
    throw new Error("BTC request failed");
  }

  const h = (await r.text()).trim();

  if (!/^[a-f0-9]{64}$/i.test(h)) {
    throw new Error("BTC hash invalid");
  }

  return h.toLowerCase();
}

async function getTRON() {
  const r = await fetch(
    "https://api.trongrid.io/wallet/getnowblock",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    }
  );

  if (!r.ok) {
    throw new Error("TRON request failed");
  }

  const d: any = await r.json();

  if (
    !d.blockID ||
    typeof d.blockID !== "string" ||
    !/^[a-f0-9]{64}$/i.test(d.blockID)
  ) {
    throw new Error("TRON hash invalid");
  }

  return d.blockID.toLowerCase();
}

async function getTON() {
  const r = await fetch(
    "https://toncenter.com/api/v3/masterchainInfo"
  );

  if (!r.ok) {
    throw new Error("TON request failed");
  }

  const d: any = await r.json();

  const candidates = [
    d.last?.hash,
    d.last?.block_id?.hash,
    d.last?.root_hash,
    d.last?.id?.hash,
    d.masterchain?.hash,
  ];

  const h = candidates.find(
    (x) => typeof x === "string" && x.length > 0
  );

  if (!h) {
    throw new Error("TON hash invalid");
  }

  return h.toLowerCase();
}

async function createRound(env: any, round: number) {
  const key = `result:${round}`;

  // 再检查一次 KV，避免已经生成却重复请求链上数据。
  const existing = await env.KV.get(key, "json");

  if (existing) {
    return existing;
  }

  /*
   * 第一次生成该 Round：
   *
   * BTC
   * TRON
   * TON
   *
   * 三个公开链数据一起进入原始数据。
   */
  const [btc, tron, ton] = await Promise.all([
    getBTC(),
    getTRON(),
    getTON(),
  ]);

  const orig = [
    "CC",
    "ROUND",
    round,
    "BTC",
    btc,
    "TRON",
    tron,
    "TON",
    ton,
  ].join("|");

  const sha = await sha256hex(orig);
  const result = await fair4(orig);

  const record = {
    version: 1,
    round,
    roundStart: roundStart(round),
    btc,
    tron,
    ton,
    orig,
    sha,
    result,
    createdAt: new Date().toISOString(),
  };

  /*
   * KV 保存该轮完整结果。
   *
   * 这里不设置 expiration。
   * 历史 Round 会永久保留，方便以后验证。
   */
  await env.KV.put(key, JSON.stringify(record));

  return record;
}

async function getRoundResult(env: any, round: number) {
  const key = `result:${round}`;

  const saved = await env.KV.get(key, "json");

  if (saved) {
    return {
      ...saved,
      cached: true,
    };
  }

  /*
   * 当前 Round 尚未生成。
   * 第一次请求负责生成。
   */
  const created = await createRound(env, round);

  return {
    ...created,
    cached: false,
  };
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: HEADERS,
  });
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    const url = new URL(request.url);

    /*
     * API:
     *
     * GET /api/result
     *
     * 返回当前 Round。
     */
    if (url.pathname === "/api/result") {
      try {
        const requestedRound = url.searchParams.get("round");

        let round = getRound();

        if (requestedRound !== null) {
          const parsed = Number(requestedRound);

          if (
            !Number.isInteger(parsed) ||
            parsed < 0
          ) {
            return json(
              {
                ok: false,
                error: "Invalid round",
              },
              400
            );
          }

          round = parsed;
        }

        const data = await getRoundResult(env, round);

        return json({
          ok: true,
          data,
        });
      } catch (error) {
        console.error("Round generation error:", error);

        return json(
          {
            ok: false,
            error: "Public blockchain data unavailable",
          },
          503
        );
      }
    }

    /*
     * API:
     *
     * GET /api/round/:id
     *
     * 用于查看已经保存的历史 Round。
     */
    if (url.pathname.startsWith("/api/round/")) {
      const id = url.pathname.split("/").pop();

      const round = Number(id);

      if (!Number.isInteger(round) || round < 0) {
        return json(
          {
            ok: false,
            error: "Invalid round",
          },
          400
        );
      }

      const key = `result:${round}`;
      const data = await env.KV.get(key, "json");

      if (!data) {
        return json(
          {
            ok: false,
            error: "Round not found",
          },
          404
        );
      }

      return json({
        ok: true,
        data,
      });
    }

    /*
     * 简单健康检查。
     */
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "Currency Club Results",
        time: new Date().toISOString(),
      });
    }

    return json(
      {
        ok: false,
        error: "Not found",
      },
      404
    );
  },
};