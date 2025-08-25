// scripts/init-db.mjs
import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = 'db/pacs.db';
const SCHEMA_PATH = 'scripts/schema.sql';

if (!existsSync(dirname(DB_PATH))) {
	mkdirSync(dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(SCHEMA_PATH, 'utf-8');
db.exec(schema);

// Seed reference tables if empty
const modalityCount = db.prepare('SELECT COUNT(*) AS c FROM modalities').get().c;
if (modalityCount === 0) {
	const insertMod = db.prepare('INSERT INTO modalities (code, name) VALUES (?, ?)');
	[
		['CT', 'Computed Tomography'],
		['MR', 'Magnetic Resonance'],
		['US', 'Ultrasound'],
		['XR', 'X-ray'],
		['MG', 'Mammography'],
		['NM', 'Nuclear Medicine'],
		['PT', 'PET'],
		['DX', 'Digital Radiography'],
		['CR', 'Computed Radiography'],
		['XA', 'X-ray Angiography'],
		['RF', 'Radiography/Fluoroscopy'],
		['OP', 'Ophthalmic Photography'],
		['OT', 'Other']
	].forEach((m) => insertMod.run(m));
}

const examTypeCount = db.prepare('SELECT COUNT(*) AS c FROM exam_types').get().c;
if (examTypeCount === 0) {
	const insertType = db.prepare('INSERT INTO exam_types (code, name) VALUES (?, ?)');

	const baseTypes = [
		// General body regions
		['BRAIN', 'Brain'],
		['HEAD', 'Head'],
		['NECK', 'Neck'],
		['FACIAL', 'Facial'],
		['PNS', 'Paranasal Sinuses'],
		['ORBIT', 'Orbit'],
		['EAR', 'Ear / Temporal bone'],
		['CPANGLE', 'Cerebellopontine Angle'],

		// Spine
		['CERVICAL', 'Cervical Spine'],
		['THORACIC', 'Thoracic Spine'],
		['LUMBAR', 'Lumbar Spine'],
		['SACRAL', 'Sacral Spine'],
		['WHOLESPINE', 'Whole Spine'],

		// Vascular – MRI / CT angiography & venography
		['BRAIN_MRA', 'Brain MRA'],
		['BRAIN_MRV', 'Brain MRV'],
		['NECK_MRA', 'Neck MRA'],
		['AORTIC_MRA', 'Aortic MRA'],
		['PERIPHERAL_MRA', 'Peripheral Limb MRA'],
		['BRAIN_CTA', 'Brain CTA'],
		['BRAIN_CTV', 'Brain CTV'],
		['CAROTID_CTA', 'Carotid CTA'],
		['AORTIC_CTA', 'Aortic CTA'],
		['CORONARY_CTA', 'Coronary CTA'],
		['PERIPHERAL_CTA', 'Peripheral CTA'],

		// Thorax / Heart
		['CHEST', 'Chest'],
		['CARDIAC', 'Cardiac MRI'],
		['CORONARY_MR', 'Coronary MR'],
		['CARDIAC_FUNCTION', 'Cardiac Function'],
		['CARDIAC_STRESS', 'Cardiac Stress MRI'],

		// Abdomen & pelvis
		['ABDOMEN', 'Abdomen'],
		['PELVIC', 'Pelvis'],
		['ABDOMEN_PELVIC', 'Abdomen & Pelvis'],
		['LIVER', 'Liver'],
		['BILIARY', 'Biliary / MRCP'],
		['PANCREAS', 'Pancreas'],
		['KIDNEY', 'Kidney'],
		['ADRENAL', 'Adrenal'],
		['PROSTATE', 'Prostate'],
		['UTERUS', 'Uterus'],
		['OVARY', 'Ovary'],

		// Musculoskeletal & joints
		['MSK', 'Musculoskeletal (General)'],
		['KNEE', 'Knee'],
		['HIP', 'Hip'],
		['ANKLE', 'Ankle'],
		['SHOULDER', 'Shoulder'],
		['ELBOW', 'Elbow'],
		['WRIST', 'Wrist'],
		['HAND', 'Hand'],
		['FOOT', 'Foot'],

		// Whole body & advanced
    ['PNS_CHEST', 'PNS & Chest'],
    ['CHEST_ABDOMEN_PELVIC', 'Chest & Abdomen & Pelvis'],
    ['NECK_CHEST_ABDOMEN_PELVIC', 'Neck & Chest & Abdomen & Pelvis'],
		['WHOLEBODY', 'Whole Body MRI'],
		['WB_MRA', 'Whole Body MRA'],
		['FUNCTIONAL_MRI', 'Functional MRI (fMRI)'],
		['SPECTROSCOPY', 'MR Spectroscopy'],
		['DWI', 'Diffusion Weighted Imaging'],
		['DCE', 'Dynamic Contrast Enhanced']
	];

	baseTypes.forEach(([code, name]) => {
		// Insert base
		insertType.run([`${code}`, `${name} without contrast`]);

		// Insert with contrast
		insertType.run([`${code}_WC`, `${name} with contrast`]);

		// Insert with & without contrast
		insertType.run([`${code}_WWC`, `${name} with & without contrast`]);
	});
}

console.log('✅ Database initialized & reference data seeded:', DB_PATH);
