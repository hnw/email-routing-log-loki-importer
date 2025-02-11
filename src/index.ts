/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.json`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

interface Env {
  API_TOKEN: string;
  ZONE_TAG: string;
  LOKI_URL: string;
  LOKI_USERNAME: string;
  LOKI_PASSWORD: string;
  LOKI_SERVICE_NAME?: string;
  VERBOSE?: number;
}

interface EmailForwardingLog {
  datetime: string;
  id: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  status: string;
  spf: string;
  dkim: string;
  dmarc: string;
  errorDetail: string | null;
  isNDR: boolean;
}

interface GraphqlResponse {
  data?: {
    viewer?: {
      zones?: {
        emailRoutingAdaptive?: EmailForwardingLog[];
      }[];
    }
  },
  errors?: {
    message?: string
  }[]
}

interface LokiEntry {
  streams: {
    stream: {
      service_name: string,
      level: string
    },
    values: string[][];
  }[];
}

const QUERY = `
  query {
    viewer {
      zones(filter: {zoneTag: $zoneTag}) {
        emailRoutingAdaptive(limit: 10000, filter: $filter, orderBy: [datetime_ASC, from_ASC, to_ASC, status_ASC]) {
          datetime
          id: sessionId
          messageId
          from
          to
          subject
          status
          spf
          dkim
          dmarc
          errorDetail
          isNDR
        }
      }
    }
  }
`;

/**
 * Cloudflare API からメール転送ログを取得する関数
 * @param {Env} env 環境変数
 * @param {number} durationSeconds 取得期間（秒）
 * @returns {Promise<EmailForwardingLog[]>} メール転送ログの配列
 */
async function getEmailForwardingLogs(env: Env, durationSeconds: number): Promise<EmailForwardingLog[]>{
  const headers = {
    "Authorization": `Bearer ${env.API_TOKEN}`,
    "Content-Type": "application/json",
  };

  const now = new Date()
  let startTime = new Date(now)
  startTime.setTime(now.getTime() - durationSeconds * 1000)
  const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
  const emailLog = []

  while (now > startTime) {
    const endTime = new Date(startTime)
    endTime.setTime(startTime.getTime() + ONE_DAY_IN_MS)
    const variables = {
      "zoneTag": env.ZONE_TAG,
      "filter": {
        "datetime_geq": startTime.toISOString(),
        "datetime_leq": endTime.toISOString(),
      },
    };
    const payload = {
      "query": QUERY,
      "variables": variables,
    };
    try {
      const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GraphQL error: check API_TOKEN. status: ${response.status}, text: ${errorText}`);
      }
      const graphqlData = await response.json() as GraphqlResponse
      if (graphqlData?.errors) {
        throw new Error(`GraphQL Analytics API error: ${graphqlData?.errors[0].message}`);
      }
      const zones = graphqlData?.data?.viewer?.zones;
      if (!zones) {
        throw new Error(`Unexpected GraphQL response: check ZONE_TAG.`);
      } else if(zones.length !== 1 || !zones[0] || !zones[0].emailRoutingAdaptive) {
        throw new Error(`Unexpected GraphQL response: zone data not found`);
      }
      if (env.VERBOSE) {
        console.log(`Received ${zones[0].emailRoutingAdaptive.length} entries from Cloudflare`)
      }
      emailLog.push(...zones[0].emailRoutingAdaptive)
    } catch (error) {
      console.error(error);
      throw error;
    }
    startTime = endTime
  }
  return emailLog;
}

/**
 * Loki にログデータを送信する関数
 * @param {Env} env 環境変数
 * @param {LokiEntry} entries Loki エントリー
 */
async function sendToLoki(env: Env, entries: LokiEntry) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (env.LOKI_USERNAME && env.LOKI_PASSWORD) {
    const encodedAuth = btoa(`${env.LOKI_USERNAME}:${env.LOKI_PASSWORD}`);
    headers["Authorization"] = `Basic ${encodedAuth}`;
  }

  const ONE_HOUR_IN_NS = 1000000000 * 60 * 60;
  while (entries.streams.length > 0) {
    try {
      const ts = Number(entries.streams[0].values[0][0]);
      const newEntries: LokiEntry = {
        streams: entries.streams.filter(
          stream => Number(stream.values[0][0]) < ts + ONE_HOUR_IN_NS
        )
      }
      entries.streams = entries.streams.filter(
        stream => Number(stream.values[0][0]) >= ts + ONE_HOUR_IN_NS
      )
      const response = await fetch(`${env.LOKI_URL}/loki/api/v1/push`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(newEntries),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to send logs to Loki: ${response.status}, ${errorText}`);
      }
      if (env.VERBOSE) {
        console.log(`Sent ${newEntries.streams.length} entries to Loki`)
      }
    } catch (error) {
      console.error(error);
      throw error
    }
  }
  if (env.VERBOSE) {
    console.log("Logs sent to Loki successfully");
  }
}

/**
 * メール転送ログを Loki に送信するための形式に変換する関数
 * @param {Env} env 環境変数
 * @param {EmailForwardingLog[]} emailLogs メール転送ログの配列
 * @returns {LokiEntry} Loki エントリー
 */
function createLokiEntries(env: Env, emailLogs: EmailForwardingLog[]): LokiEntry {
  const streams = emailLogs.map(log => {
    return {
      stream: {
        service_name: env.LOKI_SERVICE_NAME ?? 'email-routing',
        level: log.status == 'delivered' ? 'info' : 'error'
      },
      values: [[
        (() => {
          try {
            return new Date(log.datetime).getTime() * 1000000 + "";
          } catch (e) {
            console.error("Error parsing datetime:", log.datetime, e);
            return Date.now() * 1000000 + "";
          }
        })(),
        JSON.stringify(log)
      ]]
    }
  });
  return { streams };
}

async function pushEmailForwaringLogsToLoki(env: Env, emailLogs: EmailForwardingLog[]) {
  const lokiEntry = createLokiEntries(env, emailLogs)
  await sendToLoki(env, lokiEntry)
}

export default {
  /**
   * Cloudflare Workers のスケジュール機能で実行される関数
   * @param {ScheduledController} controller スケジュールコントローラー
   * @param {Env} env 環境変数
   * @param {ExecutionContext} _ 実行コンテキスト
   */
  async scheduled(controller, env, _) {
    const SECONDS_IN_A_HOUR = 3600
    const cronFields = controller.cron.split(' ');
    let durationHours = 24
    if (cronFields[1] === '*') {
      // ex: "5/30 * * * *" ==> Send logs for 1 hour
      durationHours = 1
    } else if (cronFields[1].match(/^(\*|\d+)\/\d+$/)) {
      // ex: "5 */3 * * *" ==> Send logs for 3 hours
      durationHours = Number(cronFields[1].slice(2));
    } else if (cronFields[1].match(/^\d+$/)) {
      // ex: "5 18 * * *" ==> Send logs for 24 hours
      durationHours = 24
    }
    try {
      const emailLog = await getEmailForwardingLogs(env, durationHours * SECONDS_IN_A_HOUR + 60)
      await pushEmailForwaringLogsToLoki(env, emailLog)
      return
    } catch (error: any) {
      console.log(`Error occurred: ${error.message}`);
    }
  },
  /**
   * HTTP リクエストを処理する関数
   * @returns {Promise<Response>}
   */
  async fetch(request, env, _): Promise<Response> {
    const SECONDS_IN_A_DAY = 86400
    const url = new URL(request.url)
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (isLocal) {
      const paths = url.pathname.split('/')
      if (url.pathname === '/email/logs') {
        const durationDays = Number(url.searchParams.get('days')) || 1
        const emailLog = await getEmailForwardingLogs(env, durationDays * SECONDS_IN_A_DAY)
        return new Response(JSON.stringify(emailLog), {
          headers: {
            'content-type': 'application/json;charset=UTF-8',
          },
        })
      } else if (url.pathname === '/loki/push') {
        const durationDays = Number(url.searchParams.get('days')) || 7
        const emailLog = await getEmailForwardingLogs(env, durationDays * SECONDS_IN_A_DAY)
        await pushEmailForwaringLogsToLoki(env, emailLog)
        return new Response("OK");
      }
    }
    return new Response("", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
