# email-routing-log-loki-importer

Cloudflare Workers を使用して、Cloudflare のメールルーティングログを Loki に送信するプロジェクトです。

Grafana Cloud上のGrafana Lokiで動作確認していますが、セルフホストの場合でもBasic認証を設定すれば動作するはずです。

このプロジェクトでは、Cloudflare Workers のスケジュール機能（Cron Triggers）を使用して、定期的にログを収集・送信します。
ログの転送間隔は1日1回でも動きますが、1時間に1回か30分に1回程度がオススメです。

Cloudflare API からのデータ取得や Loki へのデータ送信時にエラーが発生した場合、Workersのエラーログで確認できます。

## 準備

始める前に、以下を確認してください。

*   [Cloudflareアカウント](https://dash.cloudflare.com/sign-up/workers-and-pages)を作成
*   Cloudflareアカウントに[ドメインを追加](https://developers.cloudflare.com/fundamentals/setup/manage-domains/add-site/)
*   ドメインの[Zone ID](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/)を記録
*   ドメインの[Email Routingを有効化](https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/)
*   Cloudflareの[APIトークン](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)を作成
    - Zone.Analyticsの読み取り権限が必要です。
*   [Grafana Cloudアカウント](https://grafana.com/auth/sign-up/create-user)を作成
*   LokiのベースURLとユーザー名を取得
    - [Grafana Cloud Portal](https://grafana.com/auth/sign-in/)から左メニュー「Grafana Cloud」「<Organization名>」を選択
    - 「Manage your stack」の「Loki」「Details」ボタンを選択
    - 「Grafana Data Source settings」のURLとUserを確認
*   Lokiのアクセストークンを取得
    - [Grafana Cloud Portal](https://grafana.com/auth/sign-in/)から左メニュー「Security」「Access Policies」を選択
    - 「Create access policy」を選択し、Scopeがlogs:writeのポリシーを新規作成
    - 作成したポリシーについて「Add Token」を選択し、発行されたトークンを記録（発行したトークン自体がLokiのパスワードになります）
*   Node.jsをインストール
*   プロジェクトディレクトリで `npm install` を実行

## 設定（開発環境）

`dev.vars`ファイルを作成し、下記の環境変数を設定してください。

```
API_TOKEN=<Cloudflare API トークン>
ZONE_TAG=<Cloudflare Zone ID>
LOKI_URL=<Loki の ベースURL>
LOKI_USERNAME=<Loki のユーザー名>
LOKI_PASSWORD=<Loki のパスワード>
```

また、`wrangler.json` の `vars` セクションで下記の値を設定できます。

*    LOKI_SERVICE_NAME: Lokiのservice_name
*    VERBOSE: 冗長モード。非ゼロなら開発用ログを出力します。

## Log export mode（開発環境）

`/email/logs`にアクセスすることで、Clouflareからメール転送ログを取得し、JSONで返すことができます。この機能はlocalhostの開発環境でのみ動作します。

動作例：

```bash
$ npm run dev
$ curl "http://localhost:8787/email/logs" > /tmp/forwarding-log.json
$ jq '.[0]' < /tmp/forwarding-log.json
{
  "datetime": "2025-02-10T23:56:12Z",
  "dkim": "pass",
  "dmarc": "none",
  "errorDetail": "",
  "from": "三井住友信託銀行 <no-reply@socmedtoday.com>",
  "id": "OVT7lAlFmcee",
  "isNDR": 0,
  "messageId": "<BJDFOPAAHJPJJJICHMCGMOCCJLOO.no-reply@socmedtoday.com>",
  "spf": "pass",
  "status": "delivered",
  "subject": "【三井住友信託銀行】【要返信】お客様の直近の取引における重要な確認について",
  "to": "****@hnw.jp"
}
```

デフォルトでは1日分のログを取得します。`?days=31`のようにクエリパラメータをつけることで、内部的に複数回のGraphQLリクエストを投げて結果を返します。最大31日分のログを取得することができます。

## Batch import mode（開発環境）

`/loki/push`にアクセスすることで、Clouflareからメール転送ログを一括取得し、Lokiに書き込むことができます。この機能はlocalhostの開発環境でのみ動作します。

Lokiの制約により、最新のログより大幅に古いログは後から投入できないため、このモードは初回しか使えません。Cronの設定をする前に実行してください。

動作例：

```bash
$ npm run dev
$ curl "http://localhost:8787/loki/push"
OK
```

デフォルトでは過去7日分（Grafana CloudのLokiの上限）のログを送ります。`?days=4`のようにクエリパラメータをつけることで、送信するログの日数を指定できます。

## Scheduled import mode

Cron Triggersから起動された場合、Cloudflareから最大1日分のメール転送ログを取得し、Lokiに書き込みます。

`wrangler.json` の `triggers.crons` でログ収集スケジュールを設定できます。

```json
  "triggers": {
    "crons": [
      "5 * * * *"
    ]
  }
```
cron 式は、分、時、日、月、曜日の順で指定します。
`"5 * * * *"` は、毎時5分に実行することを意味します。
詳細については、Cloudflare Workers のドキュメント「[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)」を参照してください。

1時間以下の間隔で起動されていた場合（cronの第2パラメータを見て判断）、直近1時間のログをLokiに送ります。Lokiはログの冪等性があるため、短い間隔で起動された場合もログが重複して書き込まれることはありません。

2時間以上の間隔で起動されていた場合、前回起動時からのログを送信します。たとえば6時間間隔で起動されていた場合は直近6時間分のログをLokiに送ります。

## デプロイ（本番環境）

デプロイする前に、以下のコマンドで本番環境に受け渡す秘密情報をセットする必要があります。

```bash
$ npx wrangler secret put API_TOKEN
$ npx wrangler secret put ZONE_TAG
$ npx wrangler secret put LOKI_URL
$ npx wrangler secret put LOKI_USERNAME
$ npx wrangler secret put LOKI_PASSWORD
```

以下のコマンドでデプロイされます。

```bash
$ npm run deploy
```

本プロジェクトはCron Triggers専用ですから、公開URLは不要です。以下の手順で公開URLを無効にできます。

1. Cloudflareダッシュボードにログインします。
2. アカウントホームから、左メニュー「Compute (Workers)」「Workers & Pages」 を選択し、email-routing-log-loki-importer を選択します。
3. 「Settings」「Domains & Routes」から、「Disable」を選択し、公開されているURLを無効にします。

## Grafanaダッシュボードの設定

`grafana-dashboard.json` が私の利用しているダッシュボードです。お試しください。

## ライセンス

MIT License
