import { GoogleGenAI, Content, Part } from "@google/genai";
import { Message, AppSettings, Character, DEFAULT_SYSTEM_PROMPT, Lorebook } from '../types';

// Helper to estimate tokens (rough approximation: 4 chars = 1 token)
const estimateTokens = (text: string): number => {
    return Math.ceil(text.length / 4);
};

// Smart Context Trimmer
// Ensures System Prompt (Summary/Persona) is ALWAYS preserved.
// Trims the *middle* of the conversation if the limit is reached, keeping recent messages.
const trimHistory = (
    history: Message[], 
    systemContent: string, 
    maxContextTokens: number = 8192, 
    maxOutputTokens: number
): Message[] => {
    const systemTokens = estimateTokens(systemContent);
    const availableTokens = maxContextTokens - maxOutputTokens - systemTokens - 100; // 100 token safety buffer

    if (availableTokens <= 0) {
        console.warn("System prompt is too large for the context window! Sending only recent message.");
        return history.slice(-1);
    }

    let currentTokens = 0;
    const selectedMessages: Message[] = [];

    // Iterate backwards from the most recent message
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role === 'system') continue; // Skip system messages in history, we handle main system prompt separately

        const msgTokens = estimateTokens(msg.content) + 10; // +10 for metadata overhead (role names, etc)
        
        if (currentTokens + msgTokens > availableTokens) {
            break; // Stop adding messages if we hit the limit
        }

        selectedMessages.unshift(msg); // Add to the front of our selected list (restoring order)
        currentTokens += msgTokens;
    }

    return selectedMessages;
};

export const googleTranslateFree = async (text: string, targetLang: string = 'en'): Promise<string> => {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Translation service unreachable");
        
        const data = await res.json();
        // data[0] contains the translation segments. Map and join them.
        if (Array.isArray(data) && Array.isArray(data[0])) {
            return data[0].map((s: any) => s[0]).join("");
        }
        throw new Error("Invalid format");
    } catch (e) {
        throw e;
    }
};

const getLorebookContext = (history: Message[], character: Character, settings: AppSettings): string => {
    const activeLorebooks = [
        ...character.lorebooks.filter(lb => lb.enabled),
        ...settings.globalLorebooks.filter(lb => lb.enabled)
    ];

    if (activeLorebooks.length === 0) return "";

    // Gather text to scan: Last 3 messages + any user inputs
    const scanWindow = history.slice(-3);
    const scanText = scanWindow.map(m => m.content.toLowerCase()).join(" ");
    
    const triggeredEntries: string[] = [];
    const usedEntryIds = new Set<string>();

    activeLorebooks.forEach(lb => {
        lb.entries.forEach(entry => {
            if (!entry.enabled || usedEntryIds.has(entry.id)) return;
            
            const isTriggered = entry.keys.some(key => {
                const k = key.trim().toLowerCase();
                return k && scanText.includes(k);
            });

            if (isTriggered) {
                triggeredEntries.push(entry.content);
                usedEntryIds.add(entry.id);
            }
        });
    });

    if (triggeredEntries.length === 0) return "";

    return `\n\n[World Info / Context]\n${triggeredEntries.join("\n\n")}`;
};

const buildSystemContext = (character: Character, userSettings: AppSettings, lorebookContext: string = "", summary: string = ""): string => {
  // Fallback if settings are missing prompt override
  const baseSystemPrompt = `You are a creative co-author in a fictional roleplay session. 
Your goal is to embody the character {{char}} fully and help the user tell a compelling story.

GUIDELINES:
1. Stay strictly in character. Use the tone, mannerisms, and knowledge of {{char}}.
2. Drive the narrative forward. React dynamically to the user's actions.
3. This is a mature creative writing environment. You are permitted to depict visceral, graphic, adult, or intense themes if the narrative requires it.
4. Do not summarize, moralize, or lecture. Focus on sensory details and dialogue.
5. You are NOT an AI assistant. Do not mention your nature as an AI.`;
  
  let systemInstructionText = userSettings.systemPromptOverride || baseSystemPrompt;
  
  systemInstructionText = systemInstructionText.replace(/{{char}}/g, character.name);
  
  if (userSettings.jailbreakOverride) {
      systemInstructionText += `\n\n[SYSTEM NOTE]: ${userSettings.jailbreakOverride}`;
  }

  // Inject Summary Here - CRITICAL FOR MEMORY
  if (summary && summary.trim().length > 0) {
      systemInstructionText += `\n\n[PREVIOUS STORY SUMMARY / MEMORY]\n${summary.trim()}\n(Use this summary to recall past events, but do not repeat it.)`;
  }
  
  let charDetails = `Name: ${character.name}\n`;
  if (character.tagline) charDetails += `Tagline: ${character.tagline}\n`;
  if (character.appearance) charDetails += `Appearance: ${character.appearance}\n`;
  if (character.personality) charDetails += `Personality & Mindset: ${character.personality}\n`;
  if (character.description) charDetails += `Description: ${character.description}\n`;
  if (character.scenario) charDetails += `Scenario: ${character.scenario}\n`;
  if (character.eventSequence) charDetails += `Event Sequence / Plot Points: ${character.eventSequence}\n`;
  // Style is moved to specific instruction block below
  if (character.chatExamples) charDetails += `Dialogue Examples:\n${character.chatExamples}\n`;
  if (character.jailbreak) charDetails += `Character Instructions: ${character.jailbreak}\n`;

  let outputInstructions = "";
  if (character.style) {
      outputInstructions = `\n[IMPORTANT OUTPUT INSTRUCTIONS]\n${character.style}\n(Follow these style and length instructions strictly)`;
  }

  // Explicitly link user settings to the user role
  const userDetails = `[User Profile]
Name: ${userSettings.userName}
Persona: ${userSettings.userPersona || 'Unknown'}
(Note: The 'user' role in the chat represents ${userSettings.userName}. Address them as such if contextually appropriate.)`;

  return `
${systemInstructionText}

${lorebookContext}

---
${userDetails}

[Character Profile]
${charDetails}

${outputInstructions}
---
  `.trim();
};

const PROMPT_TEMPLATES: Record<string, { start: (r: string) => string, end: (r: string) => string, stop: string[] }> = {
    chatml: {
        start: (role) => `<|im_start|>${role}\n`,
        end: () => `<|im_end|>\n`,
        stop: ["<|im_end|>", "<|im_start|>"]
    },
    llama3: {
        start: (role) => `<|start_header_id|>${role}<|end_header_id|>\n\n`,
        end: () => `<|eot_id|>\n`,
        stop: ["<|eot_id|>", "<|start_header_id|>"]
    },
    alpaca: {
        start: (role) => role === 'system' ? '' : role === 'user' ? '### Instruction:\n' : '### Response:\n',
        end: () => '\n\n',
        stop: ["### Instruction:", "### Response:"]
    },
    vicuna: {
        start: (role) => role === 'system' ? 'SYSTEM: ' : role === 'user' ? 'USER: ' : 'ASSISTANT: ',
        end: () => '\n',
        stop: ["USER:", "ASSISTANT:"]
    },
    mistral: {
        // Simple manual formatting for Mistral Instruct
        start: (role) => role === 'user' ? '[INST] ' : '',
        end: (role) => role === 'user' ? ' [/INST]' : '</s>',
        stop: ["</s>", "[INST]"]
    },
    plain: {
        start: (role) => role === 'system' ? '' : role === 'user' ? 'User: ' : 'Model: ',
        end: () => '\n',
        stop: ["User:", "\nUser:"]
    }
};

const formatPromptForHorde = (history: Message[], character: Character, settings: AppSettings, lorebookContext: string, summary: string): { prompt: string, stop: string[] } => {
    // 1. Build System Context First (Priority 1)
    const system = buildSystemContext(character, settings, lorebookContext, summary);
    const template = PROMPT_TEMPLATES[settings.promptTemplate || 'chatml'] || PROMPT_TEMPLATES.chatml;
    
    let promptPrefix = "";
    if (settings.promptTemplate === 'plain') {
        promptPrefix += `${system}\n\n`;
    } else {
        promptPrefix += `${template.start('system')}${system}${template.end('system')}`;
    }

    // 2. Budget Logic: Horde/Kobold often has 2048, 4096 or 8192 context.
    // We assume a safe default of 4096 unless we know better, to prevent the "forgetting summary" bug.
    // If user is using a local 8k model, we utilize 8k.
    const SAFE_CONTEXT_LIMIT = 8192; 
    const maxOutput = Number(settings.maxOutputTokens) || 200;
    
    // 3. Filter History based on budget
    const trimmedHistory = trimHistory(history, promptPrefix, SAFE_CONTEXT_LIMIT, maxOutput);

    // 4. Construct Transcript from Trimmed History
    let transcript = promptPrefix;

    trimmedHistory.forEach(msg => {
        let roleName = 'user';
        if (msg.role === 'model') roleName = 'assistant';
        
        if (settings.promptTemplate === 'plain') {
             const name = msg.role === 'user' ? settings.userName : character.name;
             transcript += `${name}: ${msg.content}\n`;
        } else {
             transcript += `${template.start(roleName)}${msg.content}${template.end(roleName)}`;
        }
    });

    // 5. Add Generation Trigger
    if (settings.promptTemplate === 'plain') {
        transcript += `${character.name}:`;
    } else {
        transcript += `${template.start('assistant')}`;
    }

    return { prompt: transcript, stop: template.stop };
};

const getCommonHeaders = (settings: AppSettings): Record<string, string> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
    
    if (settings.apiKey?.trim()) {
        if (settings.apiProvider === 'horde') {
            headers['apikey'] = settings.apiKey.trim();
            headers['Client-Agent'] = 'VelvetCore:1.0:User';
        } else {
            headers['Authorization'] = `Bearer ${settings.apiKey.trim()}`;
        }
    }

    if (settings.apiProvider === 'openrouter') {
        const origin = window.location.origin;
        const href = window.location.href;
        
        const validReferer = (origin && origin !== 'null' && origin !== 'file://') 
            ? origin 
            : (href && href !== 'null' && href !== 'file://') ? href : 'http://localhost:3000';

        headers['HTTP-Referer'] = validReferer;
        headers['X-Title'] = 'VelvetCore RP';
    }

    return headers;
};

async function* generateGeminiStream(
    history: Message[], 
    character: Character, 
    settings: AppSettings,
    summary: string = "",
    signal?: AbortSignal
): AsyncGenerator<string> {
  const apiKey = settings.apiKey?.trim() || process.env.API_KEY;
  if (!apiKey) throw new Error("No API Key available for Gemini.");

  const ai = new GoogleGenAI({ apiKey });
  const lorebookContext = getLorebookContext(history, character, settings);
  const fullSystemPrompt = buildSystemContext(character, settings, lorebookContext, summary);

  // Gemini has a massive context window (1M+), so aggressive trimming isn't usually needed,
  // but we filter system messages from history to avoid confusion.
  const conversationHistory: Content[] = history
    .filter(m => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }] as Part[],
    }));

  const contents: Content[] = conversationHistory;

  const config: any = {
      temperature: Number(settings.temperature),
      maxOutputTokens: Number(settings.maxOutputTokens),
      topP: Number(settings.topP),
      topK: Number(settings.topK),
      systemInstruction: fullSystemPrompt
  };

  if (settings.modelName === 'gemini-3-flash-preview') {
      config.thinkingConfig = { thinkingBudget: 1024 };
  }

  if (settings.enableGoogleSearch) {
      config.tools = [{ googleSearch: {} }];
  }

  // Explicitly disable all safety filters
  const safetySettings = [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
  ];

  try {
      let accumulatedGroundingChunks: any[] = [];
      
      if (settings.streamResponse) {
          const result = await ai.models.generateContentStream({
            model: settings.modelName,
            contents: contents,
            config: config,
            safetySettings: safetySettings as any
          });
          for await (const chunk of result) {
              if (signal?.aborted) throw new Error("Aborted");
              const text = chunk.text;
              if (text) yield text;
              
              if (chunk.candidates?.[0]?.groundingMetadata?.groundingChunks) {
                  accumulatedGroundingChunks.push(...chunk.candidates[0].groundingMetadata.groundingChunks);
              }
          }
      } else {
          const result = await ai.models.generateContent({
            model: settings.modelName,
            contents: contents,
            config: config,
            safetySettings: safetySettings as any
          });
          if (signal?.aborted) throw new Error("Aborted");
          yield result.text || "";
          
          if (result.candidates?.[0]?.groundingMetadata?.groundingChunks) {
              accumulatedGroundingChunks = result.candidates[0].groundingMetadata.groundingChunks;
          }
      }

      if (accumulatedGroundingChunks.length > 0) {
        const uniqueSources = new Map<string, string>();
        accumulatedGroundingChunks.forEach((c: any) => {
            if (c.web?.uri && c.web?.title) {
                uniqueSources.set(c.web.uri, c.web.title);
            }
        });
        
        if (uniqueSources.size > 0) {
            yield "\n\n**Sources:**\n";
            let index = 1;
            for (const [uri, title] of uniqueSources.entries()) {
                yield `${index}. [${title}](${uri})\n`;
                index++;
            }
        }
    }
  } catch (error) {
    if ((error as any).message === "Aborted") throw error;
    console.error("Gemini API Error:", error);
    
    const errMsg = (error as any).message || "";
    const status = (error as any).status;

    if (status === 429 || errMsg.includes("429") || errMsg.includes("Quota exceeded") || errMsg.includes("Resource has been exhausted")) {
        throw new Error("QUOTA_EXCEEDED");
    }

    if (errMsg.includes("404") || status === 404) {
        throw new Error(`Model '${settings.modelName}' not found (404). Please try 'gemini-2.0-flash' in settings.`);
    }
    if (errMsg.includes("403") || status === 403) {
        throw new Error(`Permission Denied (403). Your API Key does not have access to '${settings.modelName}'. Please switch to a stable model like 'gemini-2.0-flash'.`);
    }
    throw error;
  }
}

async function* generateOpenAICompatibleStream(
    history: Message[], 
    character: Character, 
    settings: AppSettings,
    summary: string = "",
    signal?: AbortSignal
): AsyncGenerator<string> {
    let endpoint = settings.customEndpoint || 'https://api.openai.com/v1';
    if (settings.apiProvider === 'openrouter') {
        endpoint = 'https://openrouter.ai/api/v1';
    } else if (settings.apiProvider === 'deepseek') {
        endpoint = 'https://api.deepseek.com';
    } else if (settings.apiProvider === 'routeway') {
        endpoint = 'https://api.routeway.ai/v1';
    }
    
    const lorebookContext = getLorebookContext(history, character, settings);
    const systemContent = buildSystemContext(character, settings, lorebookContext, summary);
    
    // IMPORTANT: Trim history for Custom/Local/Kobold endpoints which might have small context windows.
    // We assume 8192 as a generous safety limit for custom models unless users handle it themselves.
    // This ensures the System Prompt is prioritized over old chat messages.
    const SAFE_CONTEXT_LIMIT = 8192; 
    const maxOutput = Number(settings.maxOutputTokens) || 1024;
    const trimmedHistory = trimHistory(history, systemContent, SAFE_CONTEXT_LIMIT, maxOutput);

    const messages = [
        { role: 'system', content: systemContent },
        ...trimmedHistory.map(m => ({
            role: m.role === 'model' ? 'assistant' : m.role,
            content: m.content
        }))
    ];

    let url = endpoint;
    if (!url.endsWith('/chat/completions') && !url.includes('/chat/completions')) {
        url = url.endsWith('/') ? `${url}chat/completions` : `${url}/chat/completions`;
    }

    const headers = getCommonHeaders(settings);

    const body: any = {
        model: settings.modelName,
        messages: messages,
        temperature: Number(settings.temperature),
        max_tokens: Number(settings.maxOutputTokens),
        stream: settings.streamResponse,
        top_p: Number(settings.topP),
    };

    if (settings.apiProvider === 'custom' || settings.apiProvider === 'openrouter' || settings.apiProvider === 'routeway') {
        body.repetition_penalty = Number(settings.repetitionPenalty);
        body.top_k = Number(settings.topK);
        body.top_a = Number(settings.topA);
    }

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            mode: 'cors',
            credentials: 'omit',
            signal
        });
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        if (error.message === 'Failed to fetch') {
            const isDeepSeek = settings.apiProvider === 'deepseek' || url.includes('deepseek');
            if (isDeepSeek) {
                throw new Error("DeepSeek Connection Failed: This is likely a CORS issue or a network block. DeepSeek API often requires a server-side proxy or use via OpenRouter.");
            }
            throw new Error("Network Error: Could not connect to API. This is often caused by CORS restrictions or network blocks.");
        }
        throw error;
    }

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`API Error ${response.status}: ${err}`);
    }

    if (!settings.streamResponse) {
        const data = await response.json();
        yield data.choices?.[0]?.message?.content || "";
        return;
    }

    if (!response.body) throw new Error("No response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal?.aborted) {
                throw new Error("Aborted");
            }
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; 

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                
                if (trimmed.startsWith('data: ')) {
                    const dataStr = trimmed.slice(6);
                    if (dataStr === '[DONE]') return;
                    try {
                        const json = JSON.parse(dataStr);
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) yield content;
                        
                        const reasoning = (json.choices?.[0]?.delta as any)?.reasoning_content;
                        if (reasoning) yield `<think>${reasoning}</think>`;

                    } catch (e) {}
                }
            }
        }
    } catch (e: any) {
        if (e.name === 'AbortError' || e.message === "Aborted") throw e;
        console.error("Streaming Error", e);
        throw e;
    } finally {
        try {
            reader.releaseLock();
        } catch (e) {}
    }
}

async function* generateHordeStream(
    history: Message[], 
    character: Character, 
    settings: AppSettings,
    summary: string = "",
    signal?: AbortSignal
): AsyncGenerator<string> {
    const lorebookContext = getLorebookContext(history, character, settings);
    // Uses new formatPromptForHorde which includes SMART TRIMMING
    const { prompt, stop } = formatPromptForHorde(history, character, settings, lorebookContext, summary);
    const headers = getCommonHeaders(settings);
    
    const apiKey = settings.apiKey?.trim();
    const isAnonymous = !apiKey || apiKey === '0000000000';
    const maxTokensLimit = isAnonymous ? 512 : 1024;

    const initiateUrl = 'https://stablehorde.net/api/v2/generate/text/async';
    const body = {
        prompt: prompt,
        params: {
            n: 1,
            max_context_length: 8192, // Requesting higher context from workers if possible
            max_length: Math.min(Number(settings.maxOutputTokens), maxTokensLimit), 
            temperature: Number(settings.temperature),
            stop_sequence: stop,
            top_p: Number(settings.topP),
            top_k: Number(settings.topK),
            top_a: Number(settings.topA),
            repetition_penalty: Number(settings.repetitionPenalty)
        },
        models: [settings.modelName || 'fimbulvetr-11b-v2']
    };

    const initResponse = await fetch(initiateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
    });

    if (!initResponse.ok) {
        const errText = await initResponse.text();
        try {
            const errJson = JSON.parse(errText);
            if (errJson.rc === 'KudosUpfront') {
                throw new Error(`Horde Limit Reached: Heavy traffic requires Kudos for long responses. Please lower Max Tokens to 512 or use a registered API Key.`);
            }
        } catch (e) { }
        throw new Error(`Horde Init Error: ${errText}`);
    }

    const initData = await initResponse.json();
    const id = initData.id;

    if (!id) throw new Error("Horde did not return a generation ID.");

    const statusUrl = `https://stablehorde.net/api/v2/generate/text/status/${id}`;
    
    let attempts = 0;
    while (attempts < 60) {
        if (signal?.aborted) throw new Error("Aborted");
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const statusResponse = await fetch(statusUrl, { headers, signal });
        if (!statusResponse.ok) continue; 
        
        const statusData = await statusResponse.json();
        
        if (statusData.finished === 1 || statusData.done) {
            if (statusData.generations && statusData.generations.length > 0) {
                 yield statusData.generations[0].text;
            }
            return;
        }
        
        if (statusData.faulted) {
             throw new Error("Horde Generation Faulted.");
        }
        attempts++;
    }
    throw new Error("Horde Generation Timed Out.");
}

export async function* generateCharacterStream(
    prompt: string,
    length: 'short' | 'medium' | 'long',
    settings: AppSettings,
    files: Array<{ mimeType: string, data: string }> = [],
    previousOutput?: string,
    includeSequence: boolean = false,
    signal?: AbortSignal,
    detailedSequence: boolean = false
): AsyncGenerator<string> {
    const systemPrompt = `You are an expert character writer and world builder. Your task is to create a detailed character profile based on the user's request.
Output the result strictly as a valid JSON object. Do not wrap in markdown code blocks if possible, or use \`\`\`json.

The JSON structure must be:
{
  "name": "Character Name",
  "tagline": "Short description",
  "description": "Full background and lore",
  "personality": "Psychological profile",
  "appearance": "Visual description",
  "firstMessage": "Initial greeting",
  "chatExamples": "Example dialogue",
  "scenario": "Current situation",
  "jailbreak": "Instructions for the AI model on how to play this character",
  "style": "Writing style instructions",
  "lorebooks": [ { "name": "...", "entries": [ { "keys": ["..."], "content": "..." } ] } ]${includeSequence ? ',\n  "eventSequence": "List of events"' : ''}
}

Length: ${length}
${detailedSequence ? "Include a detailed event sequence." : ""}
`;

    const userContent = previousOutput ? `[CONTINUE GENERATION FROM]: ${previousOutput}` : prompt;
    
    // Config for generation
    const genSettings = {
        ...settings,
        maxOutputTokens: length === 'long' ? 8192 : (length === 'medium' ? 4096 : 2048),
        temperature: 0.7
    };

    if (settings.apiProvider === 'gemini') {
         const apiKey = settings.apiKey?.trim() || process.env.API_KEY;
         if (!apiKey) throw new Error("No API Key available for Gemini.");
         const ai = new GoogleGenAI({ apiKey });
         
         const parts: Part[] = [];
         
         // Add text prompt
         parts.push({ text: userContent });

         // Add files
         files.forEach(f => {
             parts.push({
                 inlineData: {
                     mimeType: f.mimeType,
                     data: f.data
                 }
             });
         });

         const config: any = {
            temperature: genSettings.temperature,
            maxOutputTokens: genSettings.maxOutputTokens,
            topP: Number(settings.topP),
            topK: Number(settings.topK),
            systemInstruction: systemPrompt
        };
        
        const safetySettings = [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
        ];

        try {
             const result = await ai.models.generateContentStream({
                model: settings.modelName,
                contents: [{ role: 'user', parts: parts }],
                config: config,
                safetySettings: safetySettings as any
              });
              
              for await (const chunk of result) {
                  if (signal?.aborted) throw new Error("Aborted");
                  yield chunk.text || "";
              }
        } catch (error) {
             if ((error as any).message === "Aborted") throw error;
             const errMsg = (error as any).message || "";
             if (errMsg.includes("429") || errMsg.includes("Quota exceeded")) {
                 throw new Error("QUOTA_EXCEEDED");
             }
             throw error;
        }

    } else if (['openai', 'openrouter', 'deepseek', 'routeway', 'custom', 'kobold'].includes(settings.apiProvider)) {
        if (files.length > 0) {
            console.warn("Files are currently only supported with Gemini provider for character generation.");
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ];

        let endpoint = settings.customEndpoint || 'https://api.openai.com/v1';
        if (settings.apiProvider === 'openrouter') endpoint = 'https://openrouter.ai/api/v1';
        else if (settings.apiProvider === 'deepseek') endpoint = 'https://api.deepseek.com';
        else if (settings.apiProvider === 'routeway') endpoint = 'https://api.routeway.ai/v1';
        
        if (!endpoint.endsWith('/chat/completions') && !endpoint.includes('/chat/completions')) {
           endpoint = endpoint.endsWith('/') ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`;
        }

        const headers = getCommonHeaders(settings);
        const body: any = {
           model: settings.modelName,
           messages: messages,
           temperature: genSettings.temperature,
           max_tokens: genSettings.maxOutputTokens,
           stream: true
        };
        
        try {
           const response = await fetch(endpoint, {
               method: 'POST',
               headers,
               body: JSON.stringify(body),
               signal
           });

           if (!response.ok) throw new Error(`API Error: ${response.status}`);
           if (!response.body) throw new Error("No response body");
           
           const reader = response.body.getReader();
           const decoder = new TextDecoder();
           let buffer = '';

           while (true) {
               const { done, value } = await reader.read();
               if (done) break;
               buffer += decoder.decode(value, { stream: true });
               const lines = buffer.split('\n');
               buffer = lines.pop() || ''; 
               
               for (const line of lines) {
                   const trimmed = line.trim();
                   if (trimmed.startsWith('data: ')) {
                        const dataStr = trimmed.slice(6);
                        if (dataStr === '[DONE]') break;
                        try {
                            const json = JSON.parse(dataStr);
                            const content = json.choices?.[0]?.delta?.content;
                            if (content) yield content;
                        } catch (e) {}
                   }
               }
           }

        } catch (e) {
            throw e;
        }
    } else {
         throw new Error("Character Generation not supported for this provider yet.");
    }
}

export async function* generateResponse(
  history: Message[],
  character: Character,
  settings: AppSettings,
  summary: string = "",
  signal?: AbortSignal
): AsyncGenerator<string> {
  let totalContent = "";
  
  const initialStream = settings.apiProvider === 'gemini' 
      ? generateGeminiStream(history, character, settings, summary, signal)
      : settings.apiProvider === 'horde'
      ? generateHordeStream(history, character, settings, summary, signal)
      : generateOpenAICompatibleStream(history, character, settings, summary, signal);

  for await (const chunk of initialStream) {
      if (chunk) {
          totalContent += chunk;
          yield chunk;
      }
  }

  if (settings.minOutputEnabled && settings.minOutputLength > 0) {
      let attempts = 0;
      const targetLength = Number(settings.minOutputLength);
      
      while (totalContent.length > 0 && totalContent.length < targetLength && attempts < 5) {
          if (signal?.aborted) break;

          const currentLen = totalContent.length;
          const needed = targetLength - currentLen;
          
          const continueHistory = [
              ...history,
              { role: 'model', content: totalContent } as Message,
              { 
                  role: 'user', 
                  content: `[System Instruction: The current output length is ${currentLen} characters, but the minimum requirement is ${targetLength} characters. You MUST continue the story immediately from the last sentence. Do not stop until you have generated at least ${needed} more characters. Expand on the scene, sensory details, and character thoughts to meet this length requirement. Do not wrap up the scene yet.]` 
              } as Message
          ];

          const continueStream = settings.apiProvider === 'gemini'
              ? generateGeminiStream(continueHistory, character, settings, summary, signal)
              : settings.apiProvider === 'horde'
              ? generateHordeStream(continueHistory, character, settings, summary, signal)
              : generateOpenAICompatibleStream(continueHistory, character, settings, summary, signal);

          let newChunkAdded = false;
          for await (const chunk of continueStream) {
              if (chunk) {
                  totalContent += chunk;
                  yield chunk;
                  newChunkAdded = true;
              }
          }
          
          if (!newChunkAdded) break; 
          attempts++;
      }
  }
};

export const testConnection = async (settings: AppSettings): Promise<boolean> => {
    const dummyChar: Character = {
        id: 'test-connection',
        name: 'System',
        tagline: '', description: '', appearance: '', personality: '', firstMessage: '', chatExamples: '', avatarUrl: '', scenario: '',
        jailbreak: '', lorebooks: []
    };
    const dummyHistory: Message[] = [
        { id: 'test-msg', role: 'user', content: 'Ping', timestamp: Date.now() }
    ];

    const testSettings: AppSettings = {
        ...settings,
        maxOutputTokens: 5,
        globalLorebooks: []
    };

    try {
        const stream = generateResponse(dummyHistory, dummyChar, testSettings);
        // We just need to ensure no error is thrown during generation.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of stream) {
            break; // One chunk is enough to prove connection
        }
        return true;
    } catch (error) {
        console.error("Test connection failed:", error);
        throw error;
    }
};

export const summarizeChat = async (messages: Message[], settings: AppSettings, previousSummary?: string, length: 'short' | 'medium' | 'detailed' = 'medium'): Promise<string> => {
    const textToSummarize = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    let prompt = "";
    
    let lengthInstruction = "";
    if (length === 'short') lengthInstruction = "Summarize the events very concisely. Focus only on the absolute most critical plot points. Be brief.";
    if (length === 'medium') lengthInstruction = "Provide a balanced summary covering key events and character dynamics without getting bogged down in minor details.";
    if (length === 'detailed') lengthInstruction = "Provide a comprehensive and detailed summary. Include specific nuances, emotional context, and a thorough breakdown of the events.";

    if (previousSummary) {
         prompt = `You are maintaining a memory log for a roleplay.\n\nExisting Memory Context:\n"${previousSummary}"\n\nNew Dialogue to Process:\n${textToSummarize}\n\nTask: Summarize ONLY the events in the "New Dialogue" to append to the log. Do not rewrite the Existing Memory. ${lengthInstruction}`;
    } else {
         prompt = `Summarize the following roleplay chat history to serve as long-term memory.\n\nInstructions: ${lengthInstruction}\n\nChat History:\n${textToSummarize}`;
    }

    const summarizerChar: Character = {
        id: 'system_summarizer',
        name: 'System',
        tagline: '', description: '', appearance: '', personality: '', firstMessage: '', chatExamples: '', avatarUrl: '', scenario: '',
        jailbreak: 'You are an automated system. Output only the requested summary text without pleasantries.',
        lorebooks: []
    };

    const summarySettings: AppSettings = {
        ...settings,
        systemPromptOverride: 'You are an automated system. Output only the requested summary text without pleasantries.',
        maxOutputTokens: 2048, // Increased for detailed summaries
        minOutputEnabled: false, 
        streamResponse: false 
    };

    const inputHistory: Message[] = [{
        id: 'summary_prompt',
        role: 'user',
        content: prompt,
        timestamp: Date.now()
    }];

    let attempts = 0;
    while (attempts < 3) {
        try {
            const iterator = generateResponse(inputHistory, summarizerChar, summarySettings);
            let fullText = "";
            for await (const chunk of iterator) {
                fullText += chunk;
            }
            return fullText.trim();
        } catch (error: any) {
            attempts++;
            const errorMessage = error.message || "";
            const isTransient = errorMessage.includes('503') || errorMessage.includes('429') || errorMessage.includes('busy');
            const isNotFound = errorMessage.includes('404') || errorMessage.includes('403');

            if (isNotFound && settings.apiProvider === 'gemini' && summarySettings.modelName !== 'gemini-2.0-flash') {
                console.warn(`Summarization model ${summarySettings.modelName} failed. Falling back to gemini-2.0-flash.`);
                summarySettings.modelName = 'gemini-2.0-flash';
                continue;
            }

            if (isTransient && attempts < 3) {
                await new Promise(r => setTimeout(r, 2000 * attempts));
                continue;
            }
            console.error("Summarization failed", error);
            return "";
        }
    }
    return "";
};

export const extractJSON = (text: string): any => {
    // 1. Isolate JSON block (Markdown)
    let processed = text.trim();
    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(processed);
    if (codeBlockMatch) {
        processed = codeBlockMatch[1];
    }

    // Helper: Safely attempt various parse strategies
    const safeParse = (str: string): any => {
        // A. Try direct parse
        try { return JSON.parse(str); } catch (e) {}

        // B. Fix unescaped newlines in strings
        try {
            const fixedNewlines = str.replace(/"((?:[^"\\]|\\.)*)"/g, (match, content) => {
                return '"' + content.replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
            });
            return JSON.parse(fixedNewlines);
        } catch (e) {}

        // C. Fix trailing commas (e.g., [1, 2,])
        try {
             const fixedCommas = str.replace(/,(\s*[}\]])/g, '$1');
             return JSON.parse(fixedCommas);
        } catch (e) {}
        
        // D. Risky: Strip comments. Only do this if A-C failed.
        try {
            const fixedComments = str.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
            return JSON.parse(fixedComments);
        } catch(e) {}

        return null;
    };

    // 2. Try parsing the extracted/processed string
    let result = safeParse(processed);
    if (result && typeof result === 'object') return result;

    // 3. Brute Force: Find outermost braces
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');
    
    if (firstOpen !== -1 && lastClose > firstOpen) {
        const candidate = text.substring(firstOpen, lastClose + 1);
        result = safeParse(candidate);
        if (result && typeof result === 'object') return result;
    }

    // 4. Fuzzy Key Extraction (For malformed JSON with unescaped quotes)
    // This is specifically designed for the Character schema.
    try {
        const knownKeys = [
            'name', 'tagline', 'description', 'appearance', 'personality', 
            'scenario', 'eventSequence', 'firstMessage', 'chatExamples', 
            'jailbreak', 'avatarUrl', 'lorebooks', 'style'
        ];
        
        const extracted: any = {};
        let foundAny = false;

        // Build a regex lookahead that matches the start of any OTHER known key or end of object
        const nextKeyPattern = knownKeys.join('|');
        
        knownKeys.forEach(key => {
            // Regex explanation:
            // "key" \s* : \s* " (CAPTURE GROUP) " 
            // Followed by lookahead: space, comma/brace, space, quote, (nextKey), quote, colon OR end of object
            // This grabs everything inside the value quotes until the next structural key appears.
            const pattern = new RegExp(`"${key}"\\s*:\\s*"(.*?)"(?=\\s*(?:,\\s*"(?:${nextKeyPattern})"\\s*:|}\\s*$))`, 's');
            
            const match = processed.match(pattern);
            if (match && match[1]) {
                let val = match[1];
                // Attempt to unescape valid JSON escapes (like \" or \n) if they exist
                // If it fails (due to invalid chars), keep raw text.
                try {
                    // Wrap in quotes to use JSON.parse for unescaping
                    val = JSON.parse(`"${val}"`); 
                } catch (e) {
                    // Fallback: simple replace for common escapes
                    val = val.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                }
                extracted[key] = val;
                foundAny = true;
            }
        });

        if (foundAny) return extracted;

    } catch (e) {
        console.error("Fuzzy parse failed", e);
    }

    return null;
};