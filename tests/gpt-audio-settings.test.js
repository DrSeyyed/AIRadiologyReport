import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
	DEFAULT_GPT_AUDIO_SETTINGS,
	GPT_AUDIO_SUBSTITUTES,
	MAX_GPT_AUDIO_LIMIT_SECONDS,
	normalizeGptAudioSettings
} from '../src/lib/gpt-audio-settings.js';
import { getGptAudioSettings, setGptAudioSettings } from '../src/lib/server/gpt-audio-settings.js';

function database(t) {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.exec('CREATE TABLE application_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	return db;
}

test('upgrade defaults preserve 600 seconds and disabled substitution without writing', (t) => {
	const db = database(t);
	assert.deepEqual(DEFAULT_GPT_AUDIO_SETTINGS, { limitSeconds: 600, substitute: null });
	assert.deepEqual(getGptAudioSettings(db), DEFAULT_GPT_AUDIO_SETTINGS);
	const settings = getGptAudioSettings(db);
	settings.limitSeconds = 1;
	assert.deepEqual(getGptAudioSettings(db), DEFAULT_GPT_AUDIO_SETTINGS);
	assert.equal(db.prepare('SELECT count(*) AS count FROM application_settings').get().count, 0);
});

test('normalization accepts the full integer WAV range and all dedicated transcription choices', () => {
	assert.equal(MAX_GPT_AUDIO_LIMIT_SECONDS, Math.floor((0xffffffff - 36) / 32000));
	for (const limitSeconds of [1, 600, 601, 3600, MAX_GPT_AUDIO_LIMIT_SECONDS]) {
		assert.deepEqual(normalizeGptAudioSettings({ limitSeconds, substitute: null }), {
			limitSeconds,
			substitute: null
		});
	}
	for (const provider of GPT_AUDIO_SUBSTITUTES) {
		for (const model of provider.models) {
			assert.notEqual(model.id, 'gpt-audio-1.5');
			const input = { limitSeconds: 1200, substitute: { provider: provider.id, model: model.id } };
			const normalized = normalizeGptAudioSettings(input);
			assert.deepEqual(normalized, input);
			assert.notEqual(normalized, input);
			assert.notEqual(normalized.substitute, input.substitute);
		}
	}
});

test('normalization requires strict object shapes, positive integer limits and dedicated provider/model pairs', () => {
	for (const value of [
		null,
		undefined,
		[],
		600,
		'600',
		{},
		{ limitSeconds: 600 },
		{ substitute: null },
		{ limitSeconds: 600, substitute: null, extra: true },
		Object.assign(Object.create({ inherited: true }), DEFAULT_GPT_AUDIO_SETTINGS),
		...[
			'600',
			0,
			-1,
			0.5,
			NaN,
			Infinity,
			MAX_GPT_AUDIO_LIMIT_SECONDS + 1,
			Number.MAX_SAFE_INTEGER,
			null,
			undefined
		].map((limitSeconds) => ({ limitSeconds, substitute: null })),
		...[
			undefined,
			'',
			false,
			[],
			{},
			{ provider: 'openai' },
			{ provider: 'openai', model: 'gpt-transcribe', extra: true },
			{ provider: 'openai', model: 'gpt-audio-1.5' },
			{ provider: 'openai', model: 'scribe_v2' },
			{ provider: 'elevenlabs', model: 'gpt-transcribe' },
			{ provider: 'other', model: 'gpt-transcribe' },
			{ provider: 'openai', model: '<script>private-secret' }
		].map((substitute) => ({ limitSeconds: 600, substitute }))
	]) {
		assert.throws(
			() => normalizeGptAudioSettings(value),
			(error) => {
				assert.doesNotMatch(error.message, /private-secret|<script>/);
				return true;
			}
		);
	}
});

test('persistent upserts are independent and validation failures leave all saved values unchanged', (t) => {
	const db = database(t);
	db.prepare('INSERT INTO application_settings(key, value) VALUES (?, ?)').run(
		'report_generation_settings',
		'{"mode":"direct_audio"}'
	);
	db.prepare('INSERT INTO application_settings(key, value) VALUES (?, ?)').run(
		'transcription_settings',
		'{"provider":"openai","model":"gpt-audio-1.5"}'
	);
	const unrelated = db
		.prepare("SELECT * FROM application_settings WHERE key != 'gpt_audio_settings' ORDER BY key")
		.all();
	for (const settings of [
		{ limitSeconds: 900, substitute: { provider: 'elevenlabs', model: 'scribe_v2_medical' } },
		DEFAULT_GPT_AUDIO_SETTINGS
	]) {
		assert.deepEqual(setGptAudioSettings(db, settings), settings);
		assert.deepEqual(getGptAudioSettings(db), settings);
		assert.deepEqual(
			JSON.parse(
				db.prepare("SELECT value FROM application_settings WHERE key = 'gpt_audio_settings'").get()
					.value
			),
			settings
		);
	}
	assert.throws(() => setGptAudioSettings(db, { limitSeconds: 0, substitute: null }));
	assert.deepEqual(getGptAudioSettings(db), DEFAULT_GPT_AUDIO_SETTINGS);
	assert.deepEqual(
		db
			.prepare("SELECT * FROM application_settings WHERE key != 'gpt_audio_settings' ORDER BY key")
			.all(),
		unrelated
	);
	assert.equal(db.prepare('SELECT count(*) AS count FROM application_settings').get().count, 3);
});

test('invalid saved values produce a safe error without modifying data and explicit save repairs them', (t) => {
	const db = database(t);
	for (const value of [
		'private-secret',
		'null',
		'{}',
		'{"limitSeconds":600,"substitute":null,"extra":"private-secret"}',
		'{"limitSeconds":600,"substitute":{"provider":"openai","model":"gpt-audio-1.5"}}'
	]) {
		db.prepare(
			"INSERT INTO application_settings(key, value) VALUES ('gpt_audio_settings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
		).run(value);
		assert.throws(() => getGptAudioSettings(db), {
			message: 'Saved GPT Audio settings are invalid. Ask an administrator to save them again.'
		});
		assert.equal(
			db.prepare("SELECT value FROM application_settings WHERE key = 'gpt_audio_settings'").get()
				.value,
			value
		);
		setGptAudioSettings(db, DEFAULT_GPT_AUDIO_SETTINGS);
		assert.deepEqual(getGptAudioSettings(db), DEFAULT_GPT_AUDIO_SETTINGS);
	}
});

test('a failed atomic upsert preserves the existing policy and other settings', (t) => {
	const db = database(t);
	setGptAudioSettings(db, DEFAULT_GPT_AUDIO_SETTINGS);
	db.exec(
		"CREATE TRIGGER prevent_policy_update BEFORE UPDATE ON application_settings BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;"
	);
	assert.throws(
		() =>
			setGptAudioSettings(db, {
				limitSeconds: 1200,
				substitute: { provider: 'openai', model: 'whisper-1' }
			}),
		/synthetic write failure/
	);
	assert.deepEqual(getGptAudioSettings(db), DEFAULT_GPT_AUDIO_SETTINGS);
});
