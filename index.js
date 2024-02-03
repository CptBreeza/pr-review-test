import * as http from "http";
import * as https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import createHandler from "github-webhook-handler";
import OpenAI from "openai";

const handler = createHandler({ path: "/webhook", secret: "tars-secret" });

http.createServer(function(req, res) {
  handler(req, res, function() {
    res.statusCode = 404;
    res.end("no such location");
  });
}).listen(7777);

handler.on("error", function(err) {
  console.error("Error:", err.message);
});

handler.on("pull_request_review_comment", async function(event) {
  if (
    "created" === event.payload.action &&
    event.payload.comment.body.includes("@tars")
  ) {
    const threads = await retrieveThread(event);

    console.log("Threads:");
    console.log(threads);

    const message = await suggest(event.payload.comment.diff_hunk, threads);
    console.log("Suggest:");
    console.log(message);
  }
});

async function retrieveThread(event) {
  const {
    payload: {
      pull_request: { node_id: pullReqestId },
      comment: { node_id: commentId },
    },
  } = event;

  const document = `
    query PRReviewThreads(
      $pullReqestId: ID!
      $after: String
    ) {
      node(id: $pullReqestId) {
        ... on PullRequest {
          reviewThreads(first: 1, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ... on PullRequestReviewThread {
                comments(first: 50) {
                  nodes {
                    ... on PullRequestReviewComment {
                      id
                      body
                      author {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    `;

  let after = null;

  while (true) {
    const { data: { node: { reviewThreads: { nodes: [thread], pageInfo } } } } =
      await query(
        document,
        { pullReqestId, after },
      );

    const { comments: { nodes: comments } } = thread;

    if (comments.some((c) => c.id === commentId)) {
      return comments.map((c) => {
        return { author: c.author.login, body: c.body };
      });
    } else {
      after = pageInfo.endCursor;
    }
  }
}

async function query(document, variables) {
  const body = JSON.stringify({
    query: document,
    variables,
  });

  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GH_TOKEN}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body,
  });

  return resp.json();
}

const agent = new HttpsProxyAgent(process.env.https_proxy);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  httpAgent: agent,
  timeout: 1000 * 60 * 60 * 5,
});

async function suggest(diffHunk, threads) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [
      {
        "role": "system",
        "content": "You are a helpful assistant.",
      },
      { "role": "user", "content": buildPrompt(diffHunk, threads) },
    ],
  });

  return completion.choices[0].message.content;
}

function buildPrompt(diff_hunk, threads) {
  return `
  你是一个耐心、善良的资深高级开发者，你会认真、公正、礼貌地用中文回应我的请求。
  一位同事在 GitHub 上提交了一个 pull request，其中他做出了这样的一个修改：
  \`\`\`
  ${diff_hunk}
  \`\`\`
  在他请求其他同事 review pull request 后，其他同事对此似乎有不同的的看法，他们的意见不能达成一致，下面是他们的对话记录：
  ------
  ${threads.map((c) => `${c.author}说："${c.body}"`)}
  ------
  请结合文件的改动仔细阅读这段对话，然后发表一下你的看法，对上述对话中的每一种看法都要给出：
  1. 优点和缺点
  2. 可行性
  3. 实现难度
  你的回复可以稍微简短一些，控制在 200 字以内
  `;
}
