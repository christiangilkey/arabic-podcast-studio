-- ================================================================ v4: guilds and profile photos
-- A guild is a group of up to 50 people with a name and a short tag. A person can be in any
-- number of guilds. Any member can invite their own friends; everyone in a guild can see each
-- other's "what I am studying" card and message each other, like friends.

-- ---------------------------------------------------------------- profile photos
-- avatar_path: the user's picture inside the public "avatars" bucket (null = show their initial).
alter table public.profiles add column if not exists avatar_path text
  check (avatar_path is null or length(avatar_path) <= 200);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Pictures are world-readable by address (a public bucket); only the owner can add or remove
-- files in their own folder, avatars/<user id>/.
drop policy if exists "avatars: see own files" on storage.objects;
create policy "avatars: see own files" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars: add own" on storage.objects;
create policy "avatars: add own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars: remove own" on storage.objects;
create policy "avatars: remove own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------- guilds
create table if not exists public.guilds (
  id          uuid primary key default gen_random_uuid(),
  name        citext not null unique check (char_length(name) between 2 and 40),
  tag         text not null check (char_length(tag) between 2 and 5 and tag !~ '\s'),
  owner       uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create table if not exists public.guild_members (
  guild_id    uuid not null references public.guilds(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (guild_id, user_id)
);
create index if not exists guild_members_user on public.guild_members(user_id);
create table if not exists public.guild_invites (
  id          uuid primary key default gen_random_uuid(),
  guild_id    uuid not null references public.guilds(id) on delete cascade,
  inviter     uuid not null references public.profiles(id) on delete cascade,
  invitee     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (guild_id, invitee)
);
alter table public.guilds enable row level security;
alter table public.guild_members enable row level security;
alter table public.guild_invites enable row level security;

create or replace function public.in_guild(g uuid, person uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.guild_members where guild_id = g and user_id = person);
$$;

-- True when two different people share at least one guild.
create or replace function public.same_guild(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a <> b and exists (
    select 1 from public.guild_members x join public.guild_members y on y.guild_id = x.guild_id
    where x.user_id = a and y.user_id = b);
$$;

-- Friends, or members of the same guild.
create or replace function public.are_connected(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.are_friends(a, b) or public.same_guild(a, b);
$$;

-- Guild names and tags are public to signed-in users (they appear next to usernames).
drop policy if exists "guilds readable by signed-in users" on public.guilds;
create policy "guilds readable by signed-in users" on public.guilds
  for select to authenticated using (true);
drop policy if exists "owner edits guild" on public.guilds;
create policy "owner edits guild" on public.guilds
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "owner deletes guild" on public.guilds;
create policy "owner deletes guild" on public.guilds
  for delete to authenticated using (owner = auth.uid());

-- Who is in which guild: visible to guild-mates and to friends (for the tag by their name).
drop policy if exists "see memberships of people you know" on public.guild_members;
create policy "see memberships of people you know" on public.guild_members
  for select to authenticated
  using (user_id = auth.uid() or public.in_guild(guild_id, auth.uid()) or public.are_friends(auth.uid(), user_id));

drop policy if exists "see own guild invites" on public.guild_invites;
create policy "see own guild invites" on public.guild_invites
  for select to authenticated using (auth.uid() in (inviter, invitee));
drop policy if exists "invite a friend to my guild" on public.guild_invites;
create policy "invite a friend to my guild" on public.guild_invites
  for insert to authenticated
  with check (inviter = auth.uid() and public.in_guild(guild_id, auth.uid())
              and public.are_friends(inviter, invitee) and not public.in_guild(guild_id, invitee));
drop policy if exists "withdraw or decline guild invite" on public.guild_invites;
create policy "withdraw or decline guild invite" on public.guild_invites
  for delete to authenticated using (auth.uid() in (inviter, invitee));

-- Creating, joining and leaving go through functions so the rules can't be bent
-- (50 members at most, a guild always has an owner).
create or replace function public.create_guild(guild_name text, guild_tag text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.guilds (name, tag, owner) values (btrim(guild_name), btrim(guild_tag), auth.uid()) returning id into new_id;
  insert into public.guild_members (user_id, guild_id) values (auth.uid(), new_id);
  return new_id;
end $$;

create or replace function public.accept_guild_invite(invite_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  select guild_id into g from public.guild_invites where id = invite_id and invitee = auth.uid();
  if g is null then raise exception 'That invitation is no longer available'; end if;
  if (select count(*) from public.guild_members where guild_id = g) >= 50 then raise exception 'That guild is full'; end if;
  insert into public.guild_members (user_id, guild_id) values (auth.uid(), g) on conflict do nothing;
  delete from public.guild_invites where guild_id = g and invitee = auth.uid();
  return g;
end $$;

-- Leave a guild. If the owner leaves, the longest-standing member takes over; the last
-- person leaving closes the guild.
create or replace function public.leave_guild(g uuid) returns void
language plpgsql security definer set search_path = public as $$
declare heir uuid;
begin
  if not public.in_guild(g, auth.uid()) then return; end if;
  delete from public.guild_members where guild_id = g and user_id = auth.uid();
  if (select owner from public.guilds where id = g) = auth.uid() then
    select user_id into heir from public.guild_members where guild_id = g order by joined_at limit 1;
    if heir is null then delete from public.guilds where id = g;
    else update public.guilds set owner = heir where id = g;
    end if;
  end if;
end $$;

-- The owner removes someone from their guild.
create or replace function public.remove_guild_member(g uuid, person uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.guild_members m using public.guilds x
  where m.guild_id = g and m.user_id = person and x.id = g and x.owner = auth.uid() and person <> auth.uid();
$$;

revoke all on function public.create_guild(text, text) from public, anon;
revoke all on function public.accept_guild_invite(uuid) from public, anon;
revoke all on function public.leave_guild(uuid) from public, anon;
revoke all on function public.remove_guild_member(uuid, uuid) from public, anon;
grant execute on function public.create_guild(text, text) to authenticated;
grant execute on function public.accept_guild_invite(uuid) to authenticated;
grant execute on function public.leave_guild(uuid) to authenticated;
grant execute on function public.remove_guild_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- guild-mates count as connected
drop policy if exists "friends see status" on public.statuses;
create policy "friends see status" on public.statuses
  for select to authenticated using (user_id = auth.uid() or public.are_connected(auth.uid(), user_id));

drop policy if exists "message a friend" on public.messages;
create policy "message a friend" on public.messages
  for insert to authenticated with check (sender = auth.uid() and read_at is null
                                          and public.are_connected(sender, recipient));

drop policy if exists "voice: add to own conversations" on storage.objects;
create policy "voice: add to own conversations" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'voice' and public.in_conversation((storage.foldername(name))[1])
              and public.are_connected(split_part((storage.foldername(name))[1], '_', 1)::uuid,
                                       split_part((storage.foldername(name))[1], '_', 2)::uuid));

do $$
declare t text;
begin
  foreach t in array array['guild_members', 'guild_invites', 'guilds'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- online / offline
-- Each running app says "I'm here" about once a minute; someone counts as online while their
-- last sign of life is under about two and a half minutes old. Visible only to the person's
-- friends and guild-mates.
create table if not exists public.presence (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  last_seen  timestamptz not null default now()
);
alter table public.presence enable row level security;
drop policy if exists "connected people see presence" on public.presence;
create policy "connected people see presence" on public.presence
  for select to authenticated using (user_id = auth.uid() or public.are_connected(auth.uid(), user_id));

-- The server's clock stamps the time, so a device with a wrong clock can't appear online forever.
create or replace function public.heartbeat(online boolean default true) returns void
language sql security definer set search_path = public as $$
  insert into public.presence (user_id, last_seen)
  values (auth.uid(), case when online then now() else now() - interval '1 hour' end)
  on conflict (user_id) do update set last_seen = excluded.last_seen;
$$;
revoke all on function public.heartbeat(boolean) from public, anon;
grant execute on function public.heartbeat(boolean) to authenticated;

-- Seconds since each of these people was last seen (null = never), by the server's clock.
create or replace function public.seen_ago(people uuid[]) returns table (user_id uuid, seconds double precision)
language sql stable security definer set search_path = public as $$
  select p.user_id, extract(epoch from (now() - p.last_seen))
  from public.presence p
  where p.user_id = any(people) and (p.user_id = auth.uid() or public.are_connected(auth.uid(), p.user_id));
$$;
revoke all on function public.seen_ago(uuid[]) from public, anon;
grant execute on function public.seen_ago(uuid[]) to authenticated;
