-- Arabic Podcast Studio: social features (friends, sharing, shared folders, live quiz invites).
--
-- Everything else (library, transcripts, private vocab) stays in each user's own Google Drive.
-- Run in the Supabase SQL editor. Safe to re-run: every statement is idempotent.
--
-- Privacy model (row-level security):
--   profiles        anyone signed in can look up a username; only you can change yours
--   friendships     visible to the two people involved
--   shares          a copy sent to a friend: visible to sender and recipient only
--   shared folders  visible and editable by their members only
--   game_invites    visible to host and invitee only

create extension if not exists citext;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    citext unique check (username ~ '^[A-Za-z0-9_.]{3,20}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles readable by signed-in users" on public.profiles;
create policy "profiles readable by signed-in users" on public.profiles
  for select to authenticated using (true);
drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- A profile row is created automatically at first sign-in (username chosen later in Settings).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- friendships
create table if not exists public.friendships (
  id          uuid primary key default gen_random_uuid(),
  requester   uuid not null references public.profiles(id) on delete cascade,
  addressee   uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair on public.friendships
  (least(requester, addressee), greatest(requester, addressee));
alter table public.friendships enable row level security;

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships
                 where status = 'accepted'
                   and ((requester = a and addressee = b) or (requester = b and addressee = a)));
$$;

drop policy if exists "see own friendships" on public.friendships;
create policy "see own friendships" on public.friendships
  for select to authenticated using (auth.uid() in (requester, addressee));
drop policy if exists "send friend request" on public.friendships;
create policy "send friend request" on public.friendships
  for insert to authenticated with check (requester = auth.uid() and status = 'pending');
-- Accepting goes through a function so the only possible change is pending -> accepted.
drop policy if exists "accept friend request" on public.friendships;
create or replace function public.accept_friend(request_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.friendships set status = 'accepted'
  where id = request_id and addressee = auth.uid() and status = 'pending';
$$;
revoke all on function public.accept_friend(uuid) from public, anon;
grant execute on function public.accept_friend(uuid) to authenticated;
drop policy if exists "remove friendship" on public.friendships;
create policy "remove friendship" on public.friendships
  for delete to authenticated using (auth.uid() in (requester, addressee));

-- ---------------------------------------------------------------- shares (send a copy)
-- payload: {"words": [{text, meaning, notes, sentence, episode_title}], "folder": "name" | null}
create table if not exists public.shares (
  id          uuid primary key default gen_random_uuid(),
  sender      uuid not null references public.profiles(id) on delete cascade,
  recipient   uuid not null references public.profiles(id) on delete cascade,
  title       text not null default '' check (length(title) <= 200),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  check (octet_length(payload::text) < 1000000)
);
alter table public.shares enable row level security;

drop policy if exists "see shares sent or received" on public.shares;
create policy "see shares sent or received" on public.shares
  for select to authenticated using (auth.uid() in (sender, recipient));
drop policy if exists "share with a friend" on public.shares;
create policy "share with a friend" on public.shares
  for insert to authenticated with check (sender = auth.uid() and public.are_friends(sender, recipient));
drop policy if exists "dismiss a share" on public.shares;
create policy "dismiss a share" on public.shares
  for delete to authenticated using (auth.uid() in (sender, recipient));

-- ---------------------------------------------------------------- shared folders (live, several people)
create table if not exists public.shared_folders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 80),
  owner       uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.shared_folder_members (
  folder_id   uuid not null references public.shared_folders(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (folder_id, user_id)
);
create table if not exists public.shared_words (
  id          uuid primary key default gen_random_uuid(),
  folder_id   uuid not null references public.shared_folders(id) on delete cascade,
  text        text not null check (length(text) between 1 and 300),
  meaning     text not null default '' check (length(meaning) <= 2000),
  notes       text not null default '' check (length(notes) <= 4000),
  sentence    text not null default '' check (length(sentence) <= 2000),
  added_by    uuid references public.profiles(id) on delete set null,
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists shared_words_folder on public.shared_words(folder_id, updated_at);
alter table public.shared_folders enable row level security;
alter table public.shared_folder_members enable row level security;
alter table public.shared_words enable row level security;

create or replace function public.is_member(f uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shared_folder_members where folder_id = f and user_id = auth.uid());
$$;

drop policy if exists "members see folder" on public.shared_folders;
create policy "members see folder" on public.shared_folders
  for select to authenticated using (public.is_member(id) or owner = auth.uid());
drop policy if exists "create folder" on public.shared_folders;
create policy "create folder" on public.shared_folders
  for insert to authenticated with check (owner = auth.uid());
drop policy if exists "members rename folder" on public.shared_folders;
create policy "members rename folder" on public.shared_folders
  for update to authenticated using (public.is_member(id)) with check (public.is_member(id));
drop policy if exists "owner deletes folder" on public.shared_folders;
create policy "owner deletes folder" on public.shared_folders
  for delete to authenticated using (owner = auth.uid());

drop policy if exists "members see members" on public.shared_folder_members;
create policy "members see members" on public.shared_folder_members
  for select to authenticated using (public.is_member(folder_id));
-- The owner adds themself first; after that any member can add their own friends.
drop policy if exists "add members" on public.shared_folder_members;
create policy "add members" on public.shared_folder_members
  for insert to authenticated with check (
    (user_id = auth.uid() and exists (select 1 from public.shared_folders f where f.id = folder_id and f.owner = auth.uid()))
    or (public.is_member(folder_id) and public.are_friends(auth.uid(), user_id)));
drop policy if exists "leave folder" on public.shared_folder_members;
create policy "leave folder" on public.shared_folder_members
  for delete to authenticated using (user_id = auth.uid()
    or exists (select 1 from public.shared_folders f where f.id = folder_id and f.owner = auth.uid()));

drop policy if exists "members read words" on public.shared_words;
create policy "members read words" on public.shared_words
  for select to authenticated using (public.is_member(folder_id));
drop policy if exists "members add words" on public.shared_words;
create policy "members add words" on public.shared_words
  for insert to authenticated with check (public.is_member(folder_id) and added_by = auth.uid());
drop policy if exists "members edit words" on public.shared_words;
create policy "members edit words" on public.shared_words
  for update to authenticated using (public.is_member(folder_id)) with check (public.is_member(folder_id));

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists shared_words_touch on public.shared_words;
create trigger shared_words_touch before update on public.shared_words
  for each row execute function public.touch_updated_at();
drop trigger if exists shared_folders_touch on public.shared_folders;
create trigger shared_folders_touch before update on public.shared_folders
  for each row execute function public.touch_updated_at();
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- live quiz invites
-- The game itself runs over a Realtime channel named after the game code; this table only
-- delivers "X invited you to a quiz" to friends.
create table if not exists public.game_invites (
  id          uuid primary key default gen_random_uuid(),
  host        uuid not null references public.profiles(id) on delete cascade,
  invitee     uuid not null references public.profiles(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9]{6}$'),
  title       text not null default '',
  created_at  timestamptz not null default now()
);
alter table public.game_invites enable row level security;
drop policy if exists "see own invites" on public.game_invites;
create policy "see own invites" on public.game_invites
  for select to authenticated using (auth.uid() in (host, invitee));
drop policy if exists "invite a friend" on public.game_invites;
create policy "invite a friend" on public.game_invites
  for insert to authenticated with check (host = auth.uid() and public.are_friends(host, invitee));
drop policy if exists "dismiss invite" on public.game_invites;
create policy "dismiss invite" on public.game_invites
  for delete to authenticated using (auth.uid() in (host, invitee));

-- Live updates for the friends tab (new requests, shares, invites, shared-folder edits).
do $$
declare t text;
begin
  foreach t in array array['friendships', 'shares', 'game_invites', 'shared_words', 'shared_folder_members'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
