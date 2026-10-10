-- Self-test of the privacy rules in schema.sql, run in the Supabase SQL editor.
-- It plays three made-up users (alice, bob, carol), checks what each may do, then ends with an
-- error on purpose: that rolls everything back, so no test data is left behind. The error
-- message is the report ("RESULTS ok=… bad=…").

do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  fid uuid;
  folder uuid;
  n int;
  ok int := 0;
  bad text := '';
begin
  insert into auth.users (id, aud, role, email)
  values (a, 'authenticated', 'authenticated', 'alice@test.invalid'),
         (b, 'authenticated', 'authenticated', 'bob@test.invalid'),
         (c, 'authenticated', 'authenticated', 'carol@test.invalid');
  select count(*) into n from public.profiles where id in (a, b, c);
  if n = 3 then ok := ok + 1; else bad := bad || ' profiles-not-created'; end if;
  update public.profiles set username = 'alice_t' where id = a;
  update public.profiles set username = 'bob_t' where id = b;
  update public.profiles set username = 'carol_t' where id = c;

  -- ---- as alice
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.friendships (requester, addressee) values (a, b) returning id into fid;
  begin
    insert into public.shares (sender, recipient, payload) values (a, b, '{}');
    bad := bad || ' share-before-friends-allowed';
  exception when others then ok := ok + 1;
  end;
  begin
    insert into public.friendships (requester, addressee, status) values (a, c, 'accepted');
    bad := bad || ' self-made-accepted-friendship';
  exception when others then ok := ok + 1;
  end;
  perform public.accept_friend(fid);  -- alice can't accept her own request
  begin
    update public.profiles set username = 'stolen' where id = b;
    get diagnostics n = row_count;
    if n = 0 then ok := ok + 1; else bad := bad || ' edited-someone-elses-profile'; end if;
  exception when others then ok := ok + 1;
  end;
  execute 'reset role';
  select count(*) into n from public.friendships where id = fid and status = 'accepted';
  if n = 0 then ok := ok + 1; else bad := bad || ' requester-could-accept'; end if;

  -- ---- as bob: accept, then share with alice
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.accept_friend(fid);
  insert into public.shares (sender, recipient, title, payload) values (b, a, 'hi', '{"words": []}');
  insert into public.shared_folders (name, owner) values ('Bob & Alice', b) returning id into folder;
  insert into public.shared_folder_members (folder_id, user_id) values (folder, b);
  insert into public.shared_folder_members (folder_id, user_id) values (folder, a);
  begin
    insert into public.shared_folder_members (folder_id, user_id) values (folder, c);
    bad := bad || ' added-a-non-friend-to-folder';
  exception when others then ok := ok + 1;
  end;
  insert into public.shared_words (folder_id, text, added_by) values (folder, 'كتاب', b);
  insert into public.game_invites (host, invitee, code) values (b, a, 'ABC123');
  execute 'reset role';
  select count(*) into n from public.friendships where id = fid and status = 'accepted';
  if n = 1 then ok := ok + 1; else bad := bad || ' accept-failed'; end if;

  -- ---- as alice again: sees the share, the folder words, the invite
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.shares;
  if n = 1 then ok := ok + 1; else bad := bad || ' alice-shares=' || n; end if;
  select count(*) into n from public.shared_words;
  if n = 1 then ok := ok + 1; else bad := bad || ' alice-words=' || n; end if;
  update public.shared_words set meaning = 'book' where folder_id = folder;
  get diagnostics n = row_count;
  if n = 1 then ok := ok + 1; else bad := bad || ' alice-cant-edit-shared-word'; end if;
  select count(*) into n from public.game_invites;
  if n = 1 then ok := ok + 1; else bad := bad || ' alice-invites=' || n; end if;
  execute 'reset role';

  -- ---- as carol (not a friend of anyone): sees none of it
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.friendships) + (select count(*) from public.shares)
       + (select count(*) from public.shared_folders) + (select count(*) from public.shared_words)
       + (select count(*) from public.game_invites) into n;
  if n = 0 then ok := ok + 1; else bad := bad || ' carol-sees=' || n; end if;
  select count(*) into n from public.profiles where username in ('alice_t', 'bob_t');
  if n = 2 then ok := ok + 1; else bad := bad || ' carol-cant-look-up-usernames'; end if;
  begin
    insert into public.shared_words (folder_id, text, added_by) values (folder, 'x', c);
    bad := bad || ' carol-wrote-to-folder';
  exception when others then ok := ok + 1;
  end;
  execute 'reset role';

  -- ---- unfriend: alice removes bob
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  delete from public.friendships where id = fid;
  get diagnostics n = row_count;
  if n = 1 then ok := ok + 1; else bad := bad || ' unfriend-failed'; end if;
  execute 'reset role';

  raise exception 'RESULTS ok=% bad=[%] (everything was rolled back)', ok, coalesce(nullif(bad, ''), ' none');
end $$;
