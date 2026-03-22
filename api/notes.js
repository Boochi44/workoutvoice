// api/notes.js
// POST /api/notes — upload audio + metadata, store in Supabase, transcribe with Whisper

import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

export const config = {
  api: {
    bodyParser: false,
  },
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse the multipart form data
    const form = formidable({ keepExtensions: true });
    const [fields, files] = await form.parse(req);

    const workout_id = fields.workout_id?.[0];
    const recorded_at = fields.recorded_at?.[0];
    const latitude = fields.latitude?.[0] ?? null;
    const longitude = fields.longitude?.[0] ?? null;
    const distance_meters = fields.distance_meters?.[0] ?? null;
    const audioFile = files.audio_file?.[0];

    if (!workout_id || !recorded_at || !audioFile) {
      return res.status(400).json({ error: 'Missing required fields: workout_id, recorded_at, audio_file' });
    }

    // Upload audio file to Supabase Storage
    const fileBuffer = fs.readFileSync(audioFile.filepath);
    const fileName = `${workout_id}/${Date.now()}.m4a`;

    const { error: storageError } = await supabase.storage
      .from('audio-files')
      .upload(fileName, fileBuffer, {
        contentType: 'audio/mp4',
        upsert: false,
      });

    if (storageError) {
      console.error('Storage error:', storageError);
      return res.status(500).json({ error: 'Failed to upload audio file' });
    }

    const { data: urlData } = supabase.storage
      .from('audio-files')
      .getPublicUrl(fileName);

    const audio_file_url = urlData?.publicUrl ?? fileName;

    // Insert note record into DB with status pending
    const { data: note, error: dbError } = await supabase
      .from('notes')
      .insert({
        workout_id,
        recorded_at,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        distance_meters: distance_meters ? parseFloat(distance_meters) : null,
        audio_file_url,
        transcript_status: 'pending',
      })
      .select()
      .single();

    if (dbError) {
      console.error('DB error:', dbError);
      return res.status(500).json({ error: 'Failed to save note' });
    }

    // Send audio to Whisper for transcription
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(audioFile.filepath), {
        filename: 'audio.m4a',
        contentType: 'audio/mp4',
      });
      formData.append('model', 'whisper-1');
      formData.append('language', 'en');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        body: formData,
      });

      const whisperData = await whisperRes.json();
      const transcript = whisperData.text ?? null;

      // Update note with transcript
      await supabase
        .from('notes')
        .update({
          transcript,
          transcript_status: transcript ? 'complete' : 'failed',
          processed_at: new Date().toISOString(),
        })
        .eq('id', note.id);

      note.transcript = transcript;
      note.transcript_status = transcript ? 'complete' : 'failed';
    } catch (whisperErr) {
      console.error('Whisper error:', whisperErr);
      // Don't fail the whole request — note is saved, transcription can retry later
      await supabase
        .from('notes')
        .update({ transcript_status: 'failed' })
        .eq('id', note.id);
    }

    // Clean up temp file
    fs.unlinkSync(audioFile.filepath);

    return res.status(201).json({
      note_id: note.id,
      status: note.transcript_status,
      transcript: note.transcript ?? null,
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
