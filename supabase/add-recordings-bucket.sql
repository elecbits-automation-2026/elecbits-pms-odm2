-- ═══════════════════════════════════════════════════════════════════════════
-- A PLACE TO PUT A RECORDING
-- ───────────────────────────────────────────────────────────────────────────
-- Some calls happen where the notetaker cannot go: a client dials a phone, a
-- meeting is recorded on someone's laptop, a site visit is captured on a
-- handset. The audio exists; the transcript does not.
--
-- Fireflies will transcribe a file, but its API takes a URL — it fetches the
-- audio itself. So the file is uploaded here first and the `fireflies`
-- function hands over a SIGNED link that expires. The bucket is private:
-- nothing in it is readable by a URL alone.
--
-- Run once, in the SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recordings', 'recordings', false,
  524288000,   -- 500 MB; an hour of speech is nowhere near this
  array['audio/mpeg','audio/mp3','audio/mp4','audio/m4a','audio/x-m4a',
        'audio/wav','audio/x-wav','audio/webm','audio/ogg','video/mp4','video/webm']
)
on conflict (id) do update
  set file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public             = false;

-- Anyone signed in may add a recording, and see the list of what is there.
-- Reading the audio itself goes through a signed URL, which the server mints —
-- that is what keeps a leaked path from being a leaked recording.
drop policy if exists "signed-in can upload recordings" on storage.objects;
create policy "signed-in can upload recordings"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings');

drop policy if exists "signed-in can list recordings" on storage.objects;
create policy "signed-in can list recordings"
  on storage.objects for select to authenticated
  using (bucket_id = 'recordings');

-- Only whoever put a file there can replace or remove it. A recording of a
-- client call is not something one person should be able to erase from
-- under another.
drop policy if exists "owners can replace their recordings" on storage.objects;
create policy "owners can replace their recordings"
  on storage.objects for update to authenticated
  using (bucket_id = 'recordings' and owner = auth.uid());

drop policy if exists "owners can delete their recordings" on storage.objects;
create policy "owners can delete their recordings"
  on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and owner = auth.uid());
