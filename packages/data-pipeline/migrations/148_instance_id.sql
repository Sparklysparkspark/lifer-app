-- A stable id for this install, reported on GET /health. The desktop app uses it to recognise a
-- server however it is reached (home address, away address, a changed hostname), so everything
-- it records about a server is keyed by the id, never by a URL.
INSERT INTO install_settings (key, value)
VALUES ('instance_id', to_jsonb(gen_random_uuid()::text))
ON CONFLICT (key) DO NOTHING;
