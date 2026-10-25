# Field notes: Sales Rescue on Chord

This document describes the problems that I hit when I built and tested Sales Rescue on Chord. Each problem has four parts:

- **What happened**, with the error message or the response that I got
- **How I worked out the cause**
- **How I fixed it or worked around it**
- **What I would change in Chord**, its docs or its API

The first problems had the largest effect on the build.

## 1. Tools do not know who sent the message

### What happened

Sales Rescue uses one teammate for customers and for the shop owner. Some tools are for the owner only, for example the tools that change stock and prices. These tools must refuse a customer.

Chord knows the sender. It gives the sender ID to the model. But Chord does not send the sender ID to the MCP server. A tool gets only the arguments that the model writes. Thus, a tool cannot trust an ID in its arguments, because the model can write any value.

There was no error message. The data was not in the request. I logged 10 requests from Chord: `initialize`, `tools/list` and `tools/call`. After I removed the Cloudflare headers, each request had only these headers:

```
accept: application/json, text/event-stream
authorization: Bearer <my server token>
content-type: application/json
user-agent: Java-http-client/23.0.2
```

Each `tools/call` body had only the tool name and the arguments from the model. The body had no `params._meta` field:

```json
{"jsonrpc":"2.0","id":4776,"method":"tools/call","params":{"name":"check_stock","arguments":{"product":"brown shoulder bag"}}}
```

I tested with the partner chat API and the WhatsApp simulator. In my API tests, the sender ID was a phone number that I supplied. In the simulator, the sender ID is not a phone number. It is an ID such as `customer_ojLe-0j8o07…`. I did not test a real WhatsApp number.

### How I worked out the cause

1. I made a small MCP server that logs all headers and the full body of each request.
2. I searched the log for the sender ID of the test chat (`+2348000000001`) and for the thread ID. I found no results.
3. I asked the agent, "What do you know about me?" The agent replied with the correct sender ID.

This showed that the model has the identity of the sender, but the requests to my tools do not contain it.

### How I fixed it or worked around it

The owner sends an owner PIN in the chat, and each owner tool requires the PIN. The server keeps only a hash of the PIN. After 5 incorrect PINs, the server locks the owner tools for 15 minutes.

Each customer tool also requires the customer ID that the agent sees. The agent copies this ID into the tool arguments. The server makes sure that each order, hold and waitlist entry belongs to that customer.

This workaround has three risks:

- A person who knows the ID of a customer can act as that customer.
- A customer can lock the owner tools on purpose with incorrect PINs.
- The PIN stays in the history of the owner chat.

### What I would change in Chord

Put the conversation context in the `_meta` field of each `tools/call` request. The MCP specification reserves `_meta` for this type of data. For example:

```json
{
  "jsonrpc": "2.0",
  "id": 4776,
  "method": "tools/call",
  "params": {
    "name": "update_inventory",
    "arguments": { "sku": "FB-CHIN-JAR", "op": "increment", "value": 10 },
    "_meta": {
      "chord/context": {
        "teammate_id": "869ac045-…",
        "thread_id": "…",
        "channel": "whatsapp",
        "sender_id": "+234…"
      }
    }
  }
}
```

A tool can trust this data for two reasons:

- The model writes only `arguments`. It cannot write `_meta`.
- The bearer token already shows that the request comes from Chord.

`_meta` is better than custom HTTP headers. It works on all MCP transports, and MCP SDKs give it to the tool handler. Custom headers work only over HTTP, and some proxies remove them.

Describe the field on the MCP connections page. On a real WhatsApp channel, WhatsApp already verifies the phone number of the sender. If Chord puts that number in `_meta`, the owner does not need a PIN, and the three risks above go away.

## 2. The agent cannot see its earlier tool calls

### What happened

In a test chat, the agent called a stock tool on turn 1 and said correctly that the item was sold out. On turn 2, it called the tool again and added: "my earlier answer was right, but I gave it before checking". This was not true. On turn 3, it said that a value from an earlier tool result "was not from a check I had run".

There was no error message. In a sales chat, the same behavior can sound like this: "I did not really verify your payment." The customer then does not trust a payment that the backend did verify.

### How I worked out the cause

1. I compared the `steps` array in each `/v1/external-chat/messages` response with the reply text. Each step showed a real tool call.
2. I read the thread back with `GET /v1/threads/{id}/turns`. The history had only text turns. It had no tool calls and no tool results.

Thus, on each new turn, the model sees its earlier claims but not the tool results that support them. It then does not trust its own claims.

### How I fixed it or worked around it

- The skill tells the agent to call the tool again for each important fact: stock, price, payment and delivery. It also tells the agent never to say whether an earlier answer was checked.
- Each message from my backend ends with a reference, for example `(ref NTF-…)`. The agent uses `get_my_updates` to get the current facts for that reference.
- My database, not the agent, is the record of what happened.
- Owner tools accept the PIN on each call. A session token from an earlier turn is not useful, because the agent cannot see it on the next turn.
- Confirmation IDs are a hash of the change, not a random value. At first, a large stock change returned a random ID. On the next turn the agent could not see it, so each "yes" from the owner made a new preview and a new question. Now the same change always gets the same ID, and the agent gets it again when the owner says yes.

This workaround costs time. The agent repeats lookups on each turn. In one checkout turn, it called five tools (`get_my_updates`, `search_products` two times, `reserve_product` and `prepare_checkout`), and the turn took 10.6 seconds. All my tools are idempotent, so the repeated calls are safe.

### What I would change in Chord

- Describe exactly what the conversation history contains.
- Keep a short summary of each tool call in the history: the tool name, the result status and a short part of the result. Then the model can tell a checked fact from a guess.

## 3. The WhatsApp simulator does not show messages from the backend

### What happened

The main promise of Sales Rescue is this: when an item is available again, each customer on the waitlist gets a message. A Chord `MESSAGE` task sends this message. On API threads, the message arrives. In the WhatsApp simulator, the customer never sees it.

I sent a `MESSAGE` task directly into a simulator thread. Chord gave no error. The task status changed from `PENDING` to `COMPLETED`, and Chord stored the message as an outbound `agent` turn with `delivery_status: sent`. But the message did not appear in the simulator, also after a page reload.

I also found a second problem. The simulator thread has the participant ID `partner_BLbIscGPBR20AP8B-7cab…`. The agent sees a different ID, `customer_ojLe-0j8o07KCcypymDoj…`, and gives this ID to my tools. No API links the two IDs. Thus, the backend cannot find the correct thread for a customer.

### How I worked out the cause

I changed one thing at a time:

1. I sent the same task type to an API thread. The message arrived.
2. I found the thread ID of the simulator chat.
3. I sent a test message directly into that thread.
4. I reloaded the simulator. The message was not there.

Then I looked at the simulator page. It gets its messages from its own `/state` endpoint. That endpoint keeps only the messages that people type in the simulator and the replies to them. It does not read the Chord thread.

To compare the IDs, I put the result of `GET /v1/threads` next to the customer ID that my database stored for the same chat.

### How I fixed it or worked around it

The backend still holds the item for the customer and sends the offer immediately. This is correct for a real WhatsApp channel.

In the simulator, the customer gets the offer at their next message. When a customer sends any message, also "hi", the agent first calls the `get_my_updates` tool. If the backend holds an item for the customer, the agent tells them about it first. The skill tells the agent to think that the customer did not see the earlier message.

### What I would change in Chord

- Make the simulator show the full Chord thread. Then the simulator shows all outbound messages: agent replies, `MESSAGE` tasks and replies from a human operator. Without this change, builders cannot test proactive messages or operator takeover in the review channel.
- Use one customer ID everywhere. Put the ID that the model sees on the thread object, or put it in `_meta` as problem 1 describes.

## 4. The Catalogue has no stock fields

### What happened

The Chord dashboard has a Catalogue connector at **Admin > Channels & Tools > Tools > Catalogues**. The page says that teammates use it to give customers "items, prices, and availability". Stock is the center of Sales Rescue. Thus, I changed my plan: the owner keeps stock in the Catalogue, and the agent reads it.

There was no error message. When I added the first items, the **Add item** form had only four fields:

```
Item name    (example text: "SoftHaus Ritual (60 mins)")
Price        "In major units, e.g. 100000 or 1500.50"
Category     (optional, example text: "Massages")
Description  (optional)
```

The form has no quantity field, no "in stock" field and no SKU. It has no CSV import, so you must add items one at a time.

### How I worked out the cause

First, I examined the API. The public OpenAPI document (`GET /api-docs/public`, 101 paths) has no Catalogue endpoints. Thus, my backend cannot read the Catalogue.

Then I examined the form. It has no quantity field. The example text and the default catalogue name, "Main Menu", show that the Catalogue is for menus and price lists of services. It is not for products with stock.

### How I fixed it or worked around it

I went back to my first design. Stock is in my Postgres database. The owner changes stock in the chat with the `update_inventory` tool, which requires the owner PIN. When stock increases, the backend offers the new stock to the customers on the waitlist. The change of plan cost me approximately 40 minutes.

Later, I found a related problem with the real business. Flavorburst makes many cakes to order. A cake has no stock. It has a daily limit and a minimum notice. Chord has no model for this, so I added daily limits and dates to my backend.

### What I would change in Chord

- If the Catalogue is for products, add a quantity field, an "in stock" field and a SKU or external ID for each item.
- Add CSV import, a Catalogue API and a webhook for changes. Then a merchant can keep the Catalogue the same as their stock system.
- For made-to-order items, add a minimum notice, a daily limit and a date on the order. Salons and other service businesses have the same need for appointments.
- If the Catalogue is only for menus, change the page text. Remove the word "availability", so that builders do not plan around it.

## 5. Skills are off on a teammate that you make with the API

### What happened

I made a teammate with `POST /v1/teammates`. The request succeeded, with no error and no warning. But the skills state of the new teammate was:

```json
{"enabled": false, "generation": 0, "editable": true, "skills": []}
```

A teammate uses skills only when they are on. No API response and no guide told me that skills were off.

### How I worked out the cause

1. My setup script reads the skills state with `GET /v1/teammates/{id}/skills` before it uploads a skill. The state showed `"enabled": false`.
2. I read the Skills guide. It describes `POST /v1/teammates/{id}/skills/migrate` as a way to keep the old instructions of a teammate. A new teammate has no old instructions, so the guide did not seem to apply.
3. I tried the call on the new teammate. It turned skills on.

### How I fixed it or worked around it

I call `POST /v1/teammates/{id}/skills/migrate` immediately after I make a teammate. The call returned `200` with `"enabled": true`. Then the skill upload and publish worked. My setup script now does this for each new teammate.

### What I would change in Chord

- Turn skills on for teammates that you make through the API, or accept skill files on `POST /v1/teammates`.
- If skills are off, make a skill upload fail with a clear error that names `/skills/migrate`.
- Add one sentence about this step to the Teammates guide and the Skills guide.

## 6. The simulator and the chat APIs accept only text

### What happened

Customers of WhatsApp shops often send screenshots, and they want photos of products. I wanted the agent to read a screenshot from a customer and to send product photos. The WhatsApp simulator cannot do either. It has no file input, and it shows each message as plain text.

I did not get an error message, because the simulator gives no way to send an image.

### How I worked out the cause

1. I read the script of the simulator chat page. It sends only a text body, `api("/messages", { body })`, and it shows each message as escaped text. The page has no file input and no `<img>` element.
2. I read the API reference for the partner chat API, which the simulator uses. Its message body has a `text` field and no media field.
3. I read the API reference for operator messages, `POST /v1/threads/{id}/messages`. It says about `modality`: "`text` is the only accepted value. Anything else is `400 BAD_REQUEST`."

Thread turns can store an image, but no API that I found can write one.

### How I fixed it or worked around it

Each product has a picture link. `search_products` returns an `image_url`, and the agent sends it as text. If the merchant has no photo, my backend makes a product card at `/products/<SKU>.svg`. When a customer says that they sent a screenshot, the agent asks them to describe the item.

### What I would change in Chord

- Add images to the simulator, the partner chat API and operator messages, in both directions.
- A shop on WhatsApp sells with pictures. Without images, builders cannot test the main shopping flow.

## 7. A hand-over replaces the agent's last message, and the customer does not get it

### What happened

I wanted the agent to close an off-topic or abusive chat politely: send a short goodbye, then hand the chat to a human, so that it stops replying. The hand-over worked. The thread changed to `human_active`, the agent's reason was in the control events, and later messages got no agent reply (`"agent_invoked": false`). But the customer never saw the goodbye. The chat API returned:

```json
{"thread_id":null,"reply":null,"agent_invoked":false,"reason":"no_reply","steps":null}
```

### How I worked out the cause

I read the thread with `GET /v1/threads/{id}/turns`. The agent's goodbye was not in the thread. In its place, Chord stored its own outbound message, "One moment — connecting you with a teammate.", with `delivery_status: failed`. Thus, on a hand-over, Chord replaces the agent's reply with a fixed message, and on the partner chat API that message is not delivered.

### How I fixed it or worked around it

I split the close into two turns:

1. On the third off-topic message, the agent sends the goodbye as a normal reply. The customer sees it.
2. If the customer sends more off-topic messages, the agent hands over and does not write a reply.
3. An abusive message gets a hand-over at once.

After the hand-over, the agent does not run, so the chat uses no more credits. A scenario test checks the full sequence (6 of 6 checks pass), and normal shopping chats are not handed over.

### What I would change in Chord

- Deliver the agent's own last message when it hands over, or let the builder set the hand-over message for each teammate.
- Do not promise "connecting you with a teammate" in every case. A close for spam or abuse needs different words.
- Deliver the hand-over message on the partner chat API, or say in the docs that it is not delivered.
- Give the agent a "close conversation" action that stops replies without a human queue item, like `POST /v1/threads/{id}/pause` but available to the agent.
