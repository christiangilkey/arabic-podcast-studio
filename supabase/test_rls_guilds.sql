-- Self-test of the guild, profile-photo and online-status rules (schema v4). Run in the Supabase
-- SQL editor. Plays four made-up users, then ends with an error on purpose so everything is
-- rolled back. The error message is the report ("RESULTS ok=N bad=[...]").

do $$
declare
  a uuid := gen_random_uuid();  -- founder
  b uuid := gen_random_uuid();  -- a's friend
  c uuid := gen_random_uuid();  -- b's friend (not a's)
  d uuid := gen_random_uuid();  -- a stranger
  g uuid;
  g2 uuid;
  inv uuid;
  n int;
  ok int := 0;
  bad text := '';
begin
  insert into auth.users (id, aud, role, email)
  values (a, 'authenticated', 'authenticated', 'ga@test.invalid'), (b, 'authenticated', 'authenticated', 'gb@test.invalid'),
         (c, 'authenticated', 'authenticated', 'gc@test.invalid'), (d, 'authenticated', 'authenticated', 'gd@test.invalid');
  insert into public.friendships (requester, addressee, status) values (a, b, 'accepted'), (b, c, 'accepted');
  insert into public.statuses (user_id, message) values (c, 'studying');

  -- ---- a founds a guild and invites
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  g := public.create_guild('Test Guild Zeta', 'TGZ');
  select count(*) into n from public.guild_members where guild_id = g;
  if n = 1 then ok := ok + 1; else bad := bad || ' founder-not-a-member'; end if;
  begin
    perform public.create_guild('x', 'toolongtag');
    bad := bad || ' bad-name-or-tag-accepted';
  exception when others then ok := ok + 1;
  end;
  insert into public.guild_invites (guild_id, inviter, invitee) values (g, a, b) returning id into inv;
  begin
    insert into public.guild_invites (guild_id, inviter, invitee) values (g, a, c);
    bad := bad || ' invited-a-non-friend';
  exception when others then ok := ok + 1;
  end;
  begin
    insert into public.messages (sender, recipient, body) values (a, c, 'hi');
    bad := bad || ' messaged-a-stranger';
  exception when others then ok := ok + 1;
  end;
  insert into storage.objects (bucket_id, name) values ('avatars', a::text || '/me.webp');
  begin
    insert into storage.objects (bucket_id, name) values ('avatars', b::text || '/fake.webp');
    bad := bad || ' wrote-someone-elses-photo';
  exception when others then ok := ok + 1;
  end;
  execute 'reset role';

  -- ---- c can't let themself in; b joins, then (as a member) invites their own friend c
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.guild_members (guild_id, user_id) values (g, c);
    bad := bad || ' joined-without-invite';
  exception when others then ok := ok + 1;
  end;
  begin
    perform public.accept_guild_invite(inv);
    bad := bad || ' used-someone-elses-invite';
  exception when others then ok := ok + 1;
  end;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.accept_guild_invite(inv);
  insert into public.guild_invites (guild_id, inviter, invitee) values (g, b, c) returning id into inv;
  update public.guilds set name = 'Hijacked' where id = g;
  get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; else bad := bad || ' member-renamed-guild'; end if;
  g2 := public.create_guild('Second Guild Zeta', 'SG2');  -- any number of guilds
  select count(*) into n from public.guild_members where user_id = b;
  if n = 2 then ok := ok + 1; else bad := bad || ' second-guild=' || n; end if;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.accept_guild_invite(inv);
  perform public.heartbeat(true);
  execute 'reset role';
  select count(*) into n from public.guild_members where guild_id = g;
  if n = 3 then ok := ok + 1; else bad := bad || ' members=' || n; end if;

  -- ---- a and c are now guild-mates (not friends): they see and message each other
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.guild_members where guild_id = g;
  if n = 3 then ok := ok + 1; else bad := bad || ' founder-sees-members=' || n; end if;
  select count(*) into n from public.statuses where user_id = c;
  if n = 1 then ok := ok + 1; else bad := bad || ' cant-see-guildmate-status'; end if;
  insert into public.messages (sender, recipient, body) values (a, c, 'welcome');
  select count(*) into n from public.seen_ago(array[c]) where seconds < 150;
  if n = 1 then ok := ok + 1; else bad := bad || ' guildmate-not-online'; end if;
  update public.guilds set name = 'Renamed Guild Zeta', tag = 'RGZ' where id = g;
  get diagnostics n = row_count;
  if n = 1 then ok := ok + 1; else bad := bad || ' founder-cant-rename'; end if;
  execute 'reset role';

  -- ---- d, a stranger: sees guild names but no members, presence, statuses or messages
  perform set_config('request.jwt.claims', json_build_object('sub', d, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.guild_members) + (select count(*) from public.guild_invites)
       + (select count(*) from public.presence) + (select count(*) from public.statuses)
       + (select count(*) from public.messages) + (select count(*) from public.seen_ago(array[a, b, c])) into n;
  if n = 0 then ok := ok + 1; else bad := bad || ' stranger-sees=' || n; end if;
  select count(*) into n from public.guilds where id = g;
  if n = 1 then ok := ok + 1; else bad := bad || ' guild-name-not-public'; end if;
  perform public.remove_guild_member(g, c);
  perform public.leave_guild(g);
  begin
    insert into public.guild_invites (guild_id, inviter, invitee) values (g, d, a);
    bad := bad || ' outsider-invited';
  exception when others then ok := ok + 1;
  end;
  execute 'reset role';
  select count(*) into n from public.guild_members where guild_id = g;
  if n = 3 then ok := ok + 1; else bad := bad || ' stranger-changed-members=' || n; end if;

  -- ---- only the founder removes members; after that they are no longer connected
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.remove_guild_member(g, c);
  execute 'reset role';
  select count(*) into n from public.guild_members where guild_id = g;
  if n = 3 then ok := ok + 1; else bad := bad || ' member-removed-member'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.remove_guild_member(g, c);
  begin
    insert into public.messages (sender, recipient, body) values (a, c, 'still there?');
    bad := bad || ' messaged-after-removal';
  exception when others then ok := ok + 1;
  end;
  -- the founder leaves: the longest-standing member (b) takes over
  perform public.leave_guild(g);
  execute 'reset role';
  select count(*) into n from public.guilds where id = g and owner = b;
  if n = 1 then ok := ok + 1; else bad := bad || ' ownership-not-passed-on'; end if;

  -- the last member leaving closes the guild
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.leave_guild(g);
  execute 'reset role';
  select count(*) into n from public.guilds where id = g;
  if n = 0 then ok := ok + 1; else bad := bad || ' empty-guild-left-behind'; end if;
  select count(*) into n from public.guilds where id = g2;
  if n = 1 then ok := ok + 1; else bad := bad || ' other-guild-affected'; end if;

  raise exception 'RESULTS ok=% bad=[%] (everything was rolled back)', ok, coalesce(nullif(bad, ''), ' none');
end $$;
