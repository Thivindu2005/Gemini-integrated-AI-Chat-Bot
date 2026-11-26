// ==========================================================
// script.js - the chatbot logic (with file, photo and video attachments)
// ==========================================================

// ---------- 1. Grab the elements we need from the page ----------
const chatCard = document.querySelector(".chat");
const messagesBox = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const clearBtn = document.getElementById("clear-btn");
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const tray = document.getElementById("attachment-tray");

// ---------- 2. Settings and state ----------
// Builds the address we send questions to, for a given model name
function getApiUrl(model) {
  // streamGenerateContent sends the answer in small pieces as Gemini writes it
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
}

// The models we try, in order. If the main one is busy we switch to the backup.
// The backup is optional and comes from config.js.
const MODELS_TO_TRY = [GEMINI_MODEL];
if (typeof GEMINI_FALLBACK_MODEL !== "undefined" && GEMINI_FALLBACK_MODEL) {
  MODELS_TO_TRY.push(GEMINI_FALLBACK_MODEL);
}

// How much "thinking" Gemini does before answering. "low" is much faster for chat.
// The value comes from config.js. Leave it as "" there to use Google's default.
const THINKING_LEVEL = (typeof GEMINI_THINKING_LEVEL !== "undefined") ? GEMINI_THINKING_LEVEL : "";

// How many extra tries each model gets when Google says "too busy".
// Kept low so we switch to the backup model quickly instead of waiting around.
const RETRIES_PER_MODEL = 1;

// We only send the most recent messages. A shorter history means a smaller,
// faster request. 19 is odd on purpose so the list always starts with a user message.
const MAX_HISTORY = 19;

// This tells Gemini how to behave
const SYSTEM_PROMPT =
  "You are a friendly AI assistant. Explain things in simple words and keep your answers short and clear.";

// Gemini accepts about 20 MB per request. Files grow by roughly a third
// when we convert them to text (base64), so we stop at 14 MB in total.
const MAX_TOTAL_MB = 14;

// Gemini does not remember anything between requests,
// so we keep the whole conversation here and send it every time.
let conversation = [];

// Files the user picked but has not sent yet.
// Each item looks like { file: File, url: "blob:..." or null }
let pendingFiles = [];

// Every preview link we create, so we can free the memory when the chat is cleared
let objectUrls = [];

// True while we are waiting for Gemini to answer
let isWaiting = false;

// ---------- 3. Small icons we insert from JavaScript ----------
const BOT_SVG = `
  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <line x1="24" y1="7" x2="24" y2="12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    <circle cx="24" cy="5.5" r="2.6" fill="currentColor"/>
    <rect x="3" y="22" width="4" height="10" rx="2" fill="currentColor"/>
    <rect x="41" y="22" width="4" height="10" rx="2" fill="currentColor"/>
    <rect x="7" y="12" width="34" height="28" rx="12" fill="currentColor"/>
    <circle class="bot-eye" cx="18" cy="25" r="2.8"/>
    <circle class="bot-eye" cx="30" cy="25" r="2.8"/>
    <path class="bot-mouth" d="M20 31c2.5 2 5.5 2 8 0" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`;

// The double tick shown under the user's messages
const TICKS_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 13l4 4L14 8"/>
    <path d="M10 15l2 2L22 7"/>
  </svg>`;

// ---------- 4. Helper functions ----------

// Returns the current time like "10:30 AM"
function getTime() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Keeps the newest message in view
function scrollToBottom() {
  messagesBox.scrollTo({ top: messagesBox.scrollHeight, behavior: "smooth" });
}

// Gemini replies with markdown (**bold**, `code`, * bullets).
// This turns the basics into HTML, after making the text safe first.
function formatText(text) {
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return safe
    .replace(/^\s*\* /gm, "• ")                       // "* item" becomes "• item"
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") // **bold**
    .replace(/`(.+?)`/g, "<code>$1</code>")           // `code`
    .replace(/\n/g, "<br>");                          // new lines
}

// Disables the input while we wait for an answer
function setWaiting(state) {
  isWaiting = state;
  sendBtn.disabled = state;
  userInput.disabled = state;
  attachBtn.disabled = state;
}

// Gets the extension of a file name: "holiday.mp4" becomes "mp4"
function getExtension(fileName) {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop().slice(0, 4).toLowerCase() : "file";
}

// ---------- 5. Attachments ----------

// Is this a file type Gemini can read?
function isSupported(file) {
  return (
    file.type.startsWith("image/") ||
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/") ||
    file.type.startsWith("text/") ||
    file.type === "application/pdf"
  );
}

// Adds up the size of everything waiting to be sent
function getTotalSize() {
  return pendingFiles.reduce((total, item) => total + item.file.size, 0);
}

// Checks each chosen file and adds the good ones to pendingFiles
function addFiles(fileList) {
  for (const file of fileList) {
    if (!isSupported(file)) {
      addMessage(`"${file.name}" is not a supported file type. Try an image, video, audio, PDF or text file.`, "bot", true);
      continue;
    }

    if (getTotalSize() + file.size > MAX_TOTAL_MB * 1024 * 1024) {
      addMessage(`"${file.name}" is too big. Attachments can add up to ${MAX_TOTAL_MB} MB per message.`, "bot", true);
      continue;
    }

    // Photos and videos get a preview link so we can show them
    let url = null;
    if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
      url = URL.createObjectURL(file);
      objectUrls.push(url);
    }

    pendingFiles.push({ file: file, url: url });
  }

  renderTray();
}

// Small square preview for the tray: photo, video frame, or an extension badge
function createThumb(item) {
  const type = item.file.type;

  if (type.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "chip-thumb";
    img.src = item.url;
    img.alt = item.file.name;
    return img;
  }

  if (type.startsWith("video/")) {
    const video = document.createElement("video");
    video.className = "chip-thumb";
    video.src = item.url;
    video.muted = true;
    video.preload = "metadata";
    return video;
  }

  const badge = document.createElement("div");
  badge.className = "file-badge";
  badge.textContent = getExtension(item.file.name);
  return badge;
}

// Redraws the strip above the input bar
function renderTray() {
  tray.innerHTML = "";
  tray.hidden = pendingFiles.length === 0;

  pendingFiles.forEach((item, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = item.file.name;

    // The little x that removes the file
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${item.file.name}`);
    removeBtn.addEventListener("click", () => {
      if (item.url) URL.revokeObjectURL(item.url);
      pendingFiles.splice(index, 1);
      renderTray();
    });

    chip.appendChild(createThumb(item));
    chip.appendChild(name);
    chip.appendChild(removeBtn);
    tray.appendChild(chip);
  });
}

// Turns a file into base64 text, which is how we send it to Gemini
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    // reader.result looks like "data:image/png;base64,AAAA..."
    // we only want the part after the comma
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "the file"}`));

    reader.readAsDataURL(file);
  });
}

// Phone photos are often 3 to 8 MB, but Gemini does not need that much detail.
// We shrink big photos first, which makes the upload (and the answer) much faster.
const MAX_IMAGE_SIDE = 1280;

// Returns { mimeType, data } ready to send to Gemini
async function prepareFile(file) {
  const canResize = ["image/jpeg", "image/png", "image/webp"].includes(file.type);

  if (canResize && file.size > 300 * 1024) {
    try {
      const bitmap = await createImageBitmap(file);

      // Never make the image bigger, only smaller
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);

      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";   // JPEG has no transparency, so use a white background
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();

      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));

      // Only use the small version if it really is smaller
      if (blob && blob.size < file.size) {
        return { mimeType: "image/jpeg", data: await fileToBase64(blob) };
      }
    } catch (error) {
      console.log("Could not shrink the image, sending the original:", error);
    }
  }

  return { mimeType: file.type, data: await fileToBase64(file) };
}

// ---------- 6. Building the chat bubbles ----------

// The photo, video or file card shown inside a sent message
function createMediaElement(item) {
  const type = item.file.type;

  if (type.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "media-img";
    img.src = item.url;
    img.alt = item.file.name;
    return img;
  }

  if (type.startsWith("video/")) {
    const video = document.createElement("video");
    video.className = "media-video";
    video.src = item.url;
    video.controls = true;
    return video;
  }

  const fileCard = document.createElement("div");
  fileCard.className = "media-file";
  fileCard.textContent = `📎 ${item.file.name}`;
  return fileCard;
}

// sender is "bot" or "user". isError makes the bubble red.
// attachments is the list of files that were sent with this message.
function addMessage(text, sender, isError = false, attachments = []) {
  // The row that holds avatar + bubble + time
  const row = document.createElement("div");
  row.className = `message ${sender}`;

  // Only the bot gets an avatar
  if (sender === "bot") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.innerHTML = BOT_SVG;
    row.appendChild(avatar);
  }

  const content = document.createElement("div");
  content.className = "message-content";

  // The bubble itself
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (isError) bubble.classList.add("error");

  // Photos, videos and files go first, above the text
  if (attachments.length > 0) {
    const mediaBox = document.createElement("div");
    mediaBox.className = "bubble-media";
    attachments.forEach(item => mediaBox.appendChild(createMediaElement(item)));
    bubble.appendChild(mediaBox);
  }

  // Then the text (a message can be just a file with no text)
  if (text) {
    const textBox = document.createElement("div");

    if (sender === "bot") {
      textBox.innerHTML = formatText(text);   // safe, because formatText escapes first
    } else {
      textBox.textContent = text;             // user text is never treated as HTML
    }

    bubble.appendChild(textBox);
  }

  // The timestamp (user messages also get the double tick)
  const time = document.createElement("div");
  time.className = "time";
  time.textContent = getTime();
  if (sender === "user") {
    time.insertAdjacentHTML("beforeend", TICKS_SVG);
  }

  content.appendChild(bubble);
  content.appendChild(time);
  row.appendChild(content);
  messagesBox.appendChild(row);

  scrollToBottom();
  return bubble;
}

// The three bouncing dots shown while Gemini is thinking
function showTyping() {
  const row = document.createElement("div");
  row.className = "message bot";
  row.id = "typing-row";

  row.innerHTML = `
    <div class="avatar">${BOT_SVG}</div>
    <div class="message-content">
      <div class="bubble typing"><span></span><span></span><span></span></div>
    </div>`;

  messagesBox.appendChild(row);
  scrollToBottom();
}

function hideTyping() {
  const row = document.getElementById("typing-row");
  if (row) row.remove();
}

// The first message the bot shows
function showGreeting() {
  addMessage("Hello! 👋\nI'm your AI assistant.\nHow can I help you today?", "bot");
}

// ---------- 7. Talking to Gemini ----------

// Pauses for a number of milliseconds (used between retries)
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Reads the streamed answer piece by piece.
// onText is called every time new text arrives, with ALL the text so far.
async function readStream(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";     // text that has arrived but is not processed yet
  let fullText = "";   // the answer so far

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // The stream is made of lines. Keep the last (maybe unfinished) line for next time.
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;

      const json = line.slice(5).trim();
      if (!json) continue;

      const chunk = JSON.parse(json);
      const parts = chunk.candidates?.[0]?.content?.parts || [];

      // Join the text parts (skipping Gemini's private "thought" parts)
      const piece = parts
        .filter(part => part.text && !part.thought)
        .map(part => part.text)
        .join("");

      if (piece) {
        fullText += piece;
        onText(fullText);
      }
    }
  }

  if (!fullText) {
    throw new Error("Gemini did not return an answer. Try rephrasing your question.");
  }

  return fullText;
}

// Sends the whole conversation to Gemini and streams back the reply.
// If Google says the model is busy (503) or we hit a rate limit (429),
// we wait a moment and try again, then switch to the backup model.
async function askGemini(onText) {
  let wasBusy = false;        // did any model say "too busy"?
  let retiredMessage = "";    // Google's message if a model no longer exists

  for (const model of MODELS_TO_TRY) {
    for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {

      const startTime = performance.now();

      const response = await fetch(getApiUrl(model), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: conversation.slice(-MAX_HISTORY),
          // only added when a thinking level is set in config.js
          ...(THINKING_LEVEL && {
            generationConfig: { thinkingConfig: { thinkingLevel: THINKING_LEVEL } }
          })
        })
      });

      // Timing log: open the browser Console (F12) to see it
      const headersMs = Math.round(performance.now() - startTime);
      console.log(`[Gemini] ${model} attempt ${attempt + 1}: status ${response.status}, response started after ${headersMs} ms`);

      // Success: read the streamed answer
      if (response.ok) {
        const text = await readStream(response, onText);
        console.log(`[Gemini] ${model}: finished in ${Math.round(performance.now() - startTime)} ms`);
        return text;
      }

      // Something went wrong. Google sends the details as JSON.
      let data = await response.json();
      if (Array.isArray(data)) data = data[0];

      const errorMessage = data.error?.message || "";
      const isBusy =
        [429, 500, 502, 503, 504].includes(response.status) ||
        data.error?.status === "UNAVAILABLE" ||
        /high demand|overloaded/i.test(errorMessage);

      // A retired or unknown model will never work, so skip it and try the next one
      const isGone =
        response.status === 404 ||
        /no longer available|not found/i.test(errorMessage);
      if (isGone) {
        retiredMessage = errorMessage;
        break;   // leave the retry loop and move on to the next model
      }

      // Any other error (wrong key, bad file...) will not fix itself,
      // so show Google's message straight away
      if (!isBusy) {
        throw new Error(errorMessage || "Unknown error");
      }

      wasBusy = true;

      // Busy: wait 1 second, then 2 seconds, then try again
      if (attempt < RETRIES_PER_MODEL) {
        await wait(600);
      }
    }
  }

  // Nothing worked. Say why.
  if (!wasBusy && retiredMessage) {
    throw new Error(`${retiredMessage} Update the model names in js/config.js.`);
  }
  throw new Error("Gemini is very busy right now. Please try again in a minute.");
}

// ---------- 8. What happens when the user sends a message ----------
async function handleSend(event) {
  event.preventDefault();   // stops the page from reloading

  const text = userInput.value.trim();

  // We can send text, files, or both. Only stop if there is nothing at all.
  if ((!text && pendingFiles.length === 0) || isWaiting) return;

  // Make sure the key was added
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith("PASTE")) {
    addMessage("Add your Gemini API key in js/config.js first, then refresh the page.", "bot", true);
    return;
  }

  // Take the files out of the tray and clear it
  const attachments = pendingFiles;
  pendingFiles = [];
  renderTray();

  // Show the user's message (with its photos and videos) right away
  addMessage(text, "user", false, attachments);
  userInput.value = "";

  setWaiting(true);
  showTyping();

  let userEntry = null;   // the history item for this message
  let liveRow = null;     // the bot message that fills up while the answer streams in

  try {
    // Build the message parts: files first, then the text
    const parts = [];

    // Shrink and convert every file at the same time
    const preparedFiles = await Promise.all(attachments.map(item => prepareFile(item.file)));

    preparedFiles.forEach(file => {
      parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
    });

    // If the user sent only a file, give Gemini something to work with
    parts.push({ text: text || "Please look at the attached file(s) and tell me what they contain." });

    userEntry = { role: "user", parts: parts };
    conversation.push(userEntry);

    // The bot bubble is created when the first piece of text arrives,
    // then it grows as more text streams in
    let liveTextBox = null;

    const reply = await askGemini((textSoFar) => {
      if (!liveTextBox) {
        hideTyping();
        const bubble = addMessage("", "bot");
        liveRow = bubble.closest(".message");
        liveTextBox = document.createElement("div");
        bubble.appendChild(liveTextBox);
      }

      liveTextBox.innerHTML = formatText(textSoFar);
      messagesBox.scrollTop = messagesBox.scrollHeight;
    });

    // Re-sending big files with every question would hit the size limit,
    // so once Gemini has answered we swap the file data for a short note.
    // Gemini still remembers its own answer about the files.
    if (attachments.length > 0) {
      const names = attachments.map(item => item.file.name).join(", ");
      userEntry.parts = [{ text: `[The user attached: ${names}] ${text}` }];
    }

    // Save the answer too, so Gemini remembers the conversation
    conversation.push({ role: "model", parts: [{ text: reply }] });

    hideTyping();   // the reply is already on screen, we just make sure the dots are gone
  } catch (error) {
    // Remove the failed question so the history stays clean
    if (userEntry && conversation[conversation.length - 1] === userEntry) {
      conversation.pop();
    }

    // If a half-finished reply is on screen, remove it before showing the error
    if (liveRow) liveRow.remove();

    hideTyping();
    addMessage(`Something went wrong: ${error.message}`, "bot", true);
  } finally {
    setWaiting(false);
    userInput.focus();
  }
}

// ---------- 9. Clear the chat ----------
function clearChat() {
  conversation = [];
  pendingFiles = [];
  renderTray();
  messagesBox.innerHTML = "";

  // Free the memory used by photo and video previews
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls = [];

  showGreeting();
}

// ---------- 10. Wire everything up ----------
chatForm.addEventListener("submit", handleSend);
clearBtn.addEventListener("click", clearChat);

// The paperclip opens the hidden file picker
attachBtn.addEventListener("click", () => fileInput.click());

// When files are chosen, add them, then reset the picker
// so choosing the same file again still works
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

// Drag and drop: drop files anywhere on the chat card
chatCard.addEventListener("dragover", (event) => {
  event.preventDefault();   // needed, otherwise the browser opens the file instead
  chatCard.classList.add("drag-over");
});

chatCard.addEventListener("dragleave", (event) => {
  // only remove the highlight when leaving the card itself, not its children
  if (!chatCard.contains(event.relatedTarget)) {
    chatCard.classList.remove("drag-over");
  }
});

chatCard.addEventListener("drop", (event) => {
  event.preventDefault();
  chatCard.classList.remove("drag-over");
  if (!isWaiting) addFiles(event.dataTransfer.files);
});

showGreeting();
