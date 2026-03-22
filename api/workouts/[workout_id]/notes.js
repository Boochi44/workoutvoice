// api/workouts/[workout_id]/notes.js
// GET /api/workouts/{workout_id}/notes — retrieve all notes for a workout

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { workout_id } = req.query;

  if (!workout_id) {
    return res.status(400).json({ error: 'Missing workout_id' });
  }

  try {
    const { data: notes, error } = await supabase
      .from('notes')
      .select(`
        id,
        recorded_at,
        latitude,
        longitude,
        distance_meters,
        audio_file_url,
        transcript,
        transcript_status,
        processed_at,
        note_tags (
          confidence_score,
          tags (
            id,
            name,
            category
          )
        )
      `)
      .eq('workout_id', workout_id)
      .order('recorded_at', { ascending: true });

    if (error) {
      console.error('DB error:', error);
      return res.status(500).json({ error: 'Failed to retrieve notes' });
    }

    return res.status(200).json({ notes });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
