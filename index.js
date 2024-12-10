#!/usr/bin/node

'use strict'

import OpenAI from 'openai'
import discord from 'discord.js'
import fs from 'node:fs'
import dotenv from 'dotenv'
import { evaluate } from 'mathjs'

try {
  dotenv.config()
} catch {
  // assume environment variables are set in the environment
}

let functionCache = {}

if (!process.env.DISCORD_TOKEN) { throw new Error('DISCORD_TOKEN is not set!') }

if (!process.env.API_KEY) { throw new Error('API_KEY is not set!') }

process.env.MAX_TOKENS = Number(process.env.MAX_TOKENS)
process.env.MAX_TOKENS = Math.floor(process.env.MAX_TOKENS)
if (isNaN(process.env.MAX_TOKENS)) { console.warn('MAX_TOKENS is not a valid integer!'); process.env.MAX_TOKENS = "" }

process.env.TEMPERATURE = Number(process.env.TEMPERATURE)
if (isNaN(process.env.TEMPERATURE)) { console.warn('TEMPERATURE is not a valid number!'); process.env.TEMPERATURE = "" }

const provider = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: "https://api.mistral.ai/v1"
})

let modelIsMultimodal = false;

await provider.models.list().then((models) => {
  if (!models.data.map(model => model.id).includes(process.env.MODEL)) {
    throw new Error(process.env.MODEL, 'is not a valid MODEL!')
  }

  // check if the current model is .capabilities.vision
  if (models.data.find(model => model.id === process.env.MODEL).capabilities.vision) {
    modelIsMultimodal = true;
  }
})

const client = new discord.Client({
  intents: [
    1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 1048576, 2097152, 16777216, 33554432
  ]
})

// function to use to gracefully shutdown the bot
const shutdown = async (i) => {
  console.log('Terminating:', i)

  try {
    await client.user.setPresence({
      status: 'invisible',
      activities: []
    })
  } catch {}

  await client.destroy()
  process.exit()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', shutdown)
process.on('unhandledRejection', shutdown)

let blacklist = []

if (fs.existsSync('blacklist.json')) {
  try {
    blacklist = JSON.parse(fs.readFileSync('blacklist.json'))
  } catch (error) {
    console.warn('Error while parsing blacklist.json:', error.mesage)
  }

  fs.watch('blacklist.json', () => {
    // TO-DO: figure out why this fires twice
    try {
      blacklist = JSON.parse(fs.readFileSync('blacklist.json'))
      console.info('Blacklist updated from blacklist.json')
    } catch (error) {
      console.warn('Error while parsing blacklist.json:', error.mesage)
    }
  })
}

function isBlacklisted (id) {
  return blacklist.includes(id)
}

function makeSpecialsLlmFriendly (content, guild) {
  client.users.cache.forEach((user) => { content = content.replaceAll('<@' + user.id + '>', '<@' + user.tag + '>') }) // replace <@12345678> with <@username>
  client.users.cache.forEach((user) => { content = content.replaceAll('<@!' + user.id + '>', '<@' + user.tag + '>') }) // replace <@!12345678> with <@username>
  client.channels.cache.forEach((channel) => { content = content.replaceAll('<#' + channel.id + '>', '<#' + channel.name + '>') }) // replace <#12345678> with <#channel>
  if (guild) {
    guild.roles.cache.forEach((role) => { content = content.replaceAll('<@&' + role.id + '>', '<@&' + role.name + '>') }) // replace <@&12345678> with <@&role>
  }

  return content
}

function makeSpecialsLlmUnfriendly (content, guild) {
  client.users.cache.forEach((user) => { content = content.replaceAll('<@' + user.tag + '>', '<@' + user.id + '>') }) // replace <@username> with <@12345678>
  client.users.cache.forEach((user) => { content = content.replaceAll('<@!' + user.tag + '>', '<@!' + user.id + '>') }) // replace <@!username> with <@!12345678>
  client.channels.cache.forEach((channel) => { content = content.replaceAll('<#' + channel.name + '>', '<#' + channel.id + '>') }) // replace <#channel> with <#12345678>
  if (guild) {
    guild.roles.cache.forEach((role) => { content = content.replaceAll('<@&' + role.name + '>', '<@&' + role.id + '>') }) // replace <@&role> with <@&12345678>
  }

  return content
}

const tools = {
  math: {
    call: async (args) => { args = JSON.parse(args); return evaluate(args.expression) },
    data: { type: 'function', function: { name: 'math', description: 'Call to evaluate a mathematical expression.', parameters: { type: 'object', properties: { expression: { type: 'string', description: 'The mathematical expression to evaluate.' } }, required: ['expression'] } } }
  }
}

client.on('messageCreate', async (msg) => {
  if (msg.author.id === client.user.id) return

  if (isBlacklisted(msg.author.id) || isBlacklisted(msg.channel.id) || isBlacklisted(msg.guild.id)) { return }

  if (!msg.mentions.users.has(client.user.id) || msg.author.bot) return

  try {
    await msg.channel.sendTyping()
  } catch {
    return // an error here means we can't send messages, so don't even bother.
  }

  const typer = setInterval(() => { msg.channel.sendTyping() }, 5000)
  // may need to be reduced to accomodate worse internet connections

  // fetch 100 messages
  try {
    // eslint-disable-next-line no-var
    var channelMessages = await msg.channel.messages.fetch({ limit: 100 })
  } catch {
    clearInterval(typer)
    return
  }

  const messages = [
    {
      role: 'system',
      content:
`- You are an AI assistant, based on the "${process.env.MODEL}" model, named ${client.user.tag}.
- You are in the "${msg.channel.name}" channel (<#${msg.channel.id}>) of the "${msg.guild.name}" Discord server.
- UTC time: ${new Date().toISOString()} (UNIX: ${Math.floor(Date.now() / 1000)}).
- Use informal language with all-lowercase and only 1-2 sentences.
${(process.env.VISION_MODEL && process.env.VISION_MODEL !== process.env.MODEL) ? `- You are provided image descriptions by the ${process.env.VISION_MODEL} model.` : ''}
- Engage in role-playing actions only when requested.
- Available emojis: ${JSON.stringify(msg.guild.emojis.cache.map(emoji => `<:${emoji.name}:${emoji.id}>`))}.
- Avoid using "UwU" or "OwO" as they are deprecated, instead using ":3".
- Function calls are not visible to the user. If you are not certain about whether to call a function, don't call it.`
    }
  ]

  channelMessages = channelMessages.reverse()

  for (let message of channelMessages) {
    message = message[1]

    if (message.author.id === client.user.id) {
      if (message.type === 7) {
        messages.push({ role: 'assistant', content: `<@${message.author.id}> joined the server.` })
      } else {
        messages.push({ role: 'assistant', content: makeSpecialsLlmFriendly(message.content) || '[NO CONTENT]' })
      }
    } else {
      let content = [{ type: 'text', text: '' }]

      if (message.type === 7) {
        messages.push({ role: 'user', content: `<@${message.author.id}> joined the server.` })
        continue
      }

      content[0].text += new Date().toISOString() + '\n'
      content[0].text += `<@${message.author.tag}>`
      if (message.author.nickname) { content[0].text += ` (${message.author.nickname})` }
      if (message.author.bot) { content[0].text += ' (BOT)' }
      if (message.editedTimestamp) { content[0].text += ' (edited)' }
      if (message.type === 19) {
        try {
          content[0].text += ` (replying to <@${client.users.cache.get((await message.fetchReference()).author.id).tag || 'unknown'}>)`
        } catch {
          content[0].text += ' (replying to deleted message)'
        }
      }

      content[0].text += ':\n' + makeSpecialsLlmFriendly(message.content, message.guild)

      if (message.reactions.cache.size > 0) {
        content[0].text += '\n\n'

        const reactions = {}

        // eslint-disable-next-line no-unused-vars
        for (const [_, reaction] of message.reactions.cache.entries()) {
          // Fetch users who reacted with this emoji
          const users = await reaction.users.fetch()

          // Convert the users collection to an array of user IDs or usernames
          const userList = users.map(user => user.username)

          // Store the users in the reactionsData object
          reactions[reaction.emoji.toString()] = userList
        }

        content[0].text += 'Reactions: ' + JSON.stringify(reactions)
      }

      if (message.attachments.size > 0) {
        content[0].text += '\n\n'

        for (let attachment of message.attachments) {
          attachment = attachment[1]

          if (attachment.contentType?.startsWith('image/') && modelIsMultimodal) {
            if (process.env.MODEL === process.env.VISION_MODEL) {
              content.push({ type: 'image_url', image_url: { url: attachment.url } })
            }
          }
        }

        content[0].text += message.attachments.size + ' attachment(s): ' + JSON.stringify(Array.from(message.attachments.values()))
      }

      if (content.length === 1) {
        content = content[0].text
      }

      // 1970-01-01T00:00:00.000Z
      // <@abc> (BOT) (edited) (replying to <@xyz>):
      // example message content here
      //
      // 123 attachment(s): [ ... ]

      messages.push({ role: 'user', content })
    }
  }

  if (true) {
    let imagesSoFar = 0

    // TO-DO: rework this AI-generated code
    for (let i = messages.length - 1; i >= 0; i--) { // start from the end of the array
      if (typeof messages[i].content === 'string') { continue }

      for (let j = messages[i].content.length - 1; j >= 0; j--) { // start from the end of the inner array
        if (messages[i].content[j].type === 'image_url') {
          imagesSoFar++

          if (imagesSoFar > 8) {
            messages[i].content.splice(j, 1)
          }
        }
      }
    }
  }

  const reply = { content: '', files: [], embeds: [] }

  try {
    while (true) {
      fs.writeFileSync('/tmp/dump.json', JSON.stringify(messages, null, 4))
      let response = await provider.chat.completions.create({
        model: process.env.MODEL,
        messages,
        tools: Object.values(tools).map(tool => tool.data),
        max_tokens: Number(process.env.MAX_TOKENS),
        temperature: Number(process.env.TEMPERATURE)
      })

      response = response.choices[0].message

      messages.push(response)

      reply.content += response.content

      if (response.tool_calls) {
        for (const toolCall of response.tool_calls) {
          const tool = tools[toolCall.function.name]

          if (!tool) {
            continue
          }

          let result
          try {
            // eslint-disable-next-line no-var
            result = await tool.call(toolCall.function.arguments)
          } catch (error) {
            result = error.message
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          })
        }
      } else {
        break
      }
    }
  } catch (error) {
    reply.content = '⚠️ ' + error.message
    reply.files.push(new discord.AttachmentBuilder(Buffer.from(JSON.stringify(error.response?.data, null, 4) || error.stack), { name: 'error.json' }))

    // check if ./errors/ exists
    if (fs.existsSync('./errors/')) {
      fs.writeFileSync('./errors/' + new Date().getTime() + '.json', JSON.stringify([messages, error.message, error.stack])) // once in heat death of universe race condition
    }
  }

  clearInterval(typer)

  if (reply.content === '') { return }

  reply.content = reply.content.replaceAll(/\bregex\b/gi, (match) => {
    let replacement = "REGRET";
    return replacement
        .split("")
        .map((char, index) => {
            if (index < match.length && match[index] === match[index].toUpperCase()) {
                return char.toUpperCase();
            } else {
                return char.toLowerCase();
            }
        })
        .join("");
});


  // fs.writeFileSync('/tmp/dump.json', JSON.stringify(messages, null, 4))

  reply.content = makeSpecialsLlmUnfriendly(reply.content, msg.guild)

  if (reply.content.length > 2000) {
    reply.files.push(new discord.AttachmentBuilder(Buffer.from(reply.content), { name: 'message.txt' }))
    reply.content = reply.content.slice(0, 2000)
  }

  try {
    await msg.reply(reply)
  } catch {
    try {
      await msg.channel.send(reply)
    } catch { /* ¯\_(ツ)_/¯ */ }
  }
})

client.login(process.env.DISCORD_TOKEN)

client.on('ready', async () => {
  console.log('ready on', client.user.tag)

  // client.application.edit("custom bot about me here");

  // client.user.setActivity("custom bot status here", { "type": discord.ActivityType.Custom });
})
