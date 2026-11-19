import { GoogleGenAI } from '@google/genai';

export interface GeminiAudioPayload {
  base64Audio: string;
  mimeType: string;
}

export class GeminiTTSService {
  public async synthesize(
    apiKey: string,
    text: string,
    lang: 'fr' | 'en',
    voiceName = 'Kore',
    signal?: AbortSignal,
  ): Promise<GeminiAudioPayload | null> {
    if (!apiKey.trim() || !text.trim() || signal?.aborted) {
      return null;
    }

    const client = new GoogleGenAI({ apiKey });
    const style =
      lang === 'fr'
        ? 'Speak warmly and clearly in natural French like a supportive senior pair programmer.'
        : 'Speak warmly and clearly in natural English like a supportive senior pair programmer.';

    const interaction = await client.interactions.create({
      model: 'gemini-3.8-flash-lite-tts',
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text,
              annotations: [
                {
                  type: 'speech_metadata',
                  style,
                },
              ],
            },
          ],
        },
      ],
      response_format: {
        type: 'audio',
        mime_type: 'audio/wav',
      },
      generation_config: {
        speech_config: [{ voice: voiceName || 'Kore' }],
      },
    });

    if (signal?.aborted) {
      return null;
    }

    const audio = interaction.output_audio;
    if (!audio?.data) {
      return null;
    }

    return {
      base64Audio: audio.data,
      mimeType: audio.mime_type ?? 'audio/wav',
    };
  }
}
