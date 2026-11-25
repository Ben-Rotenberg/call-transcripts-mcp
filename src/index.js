// Call Transcripts MCP — a Cloudflare Worker that
//  1. pulls Cube ACR call recordings from a Google Drive folder (cron),
//  2. transcribes them with OpenAI,
//  3. stores transcripts in D1 (with Hebrew-friendly full-text search) for RETENTION_DAYS,
//  4. exposes them to Claude as a remote MCP server (Streamable HTTP, stateless).

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS calls ( id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, contact_name TEXT, phone_number TEXT, channel TEXT, direction TEXT, call_time TEXT, duration_sec INTEGER, size_bytes INTEGER, sidecar_id TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT, attempts INTEGER NOT NULL DEFAULT 0, model TEXT, transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), transcribed_at TEXT, exported INTEGER NOT NULL DEFAULT 0 );",
  "CREATE INDEX IF NOT EXISTS idx_calls_time ON calls(call_time);",
  "CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);",
  "CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')) );",
  "CREATE VIRTUAL TABLE IF NOT EXISTS calls_fts USING fts5( contact_name, phone_number, transcript, content='calls', content_rowid='id', tokenize='trigram' );",
  "CREATE TRIGGER IF NOT EXISTS calls_ai AFTER INSERT ON calls BEGIN INSERT INTO calls_fts(rowid, contact_name, phone_number, transcript) VALUES (new.id, new.contact_name, new.phone_number, new.transcript); END;",
  "CREATE TRIGGER IF NOT EXISTS calls_ad AFTER DELETE ON calls BEGIN INSERT INTO calls_fts(calls_fts, rowid, contact_name, phone_number, transcript) VALUES ('delete', old.id, old.contact_name, old.phone_number, old.transcript); END;",
  "CREATE TRIGGER IF NOT EXISTS calls_au AFTER UPDATE ON calls BEGIN INSERT INTO calls_fts(calls_fts, rowid, contact_name, phone_number, transcript) VALUES ('delete', old.id, old.contact_name, old.phone_number, old.transcript); INSERT INTO calls_fts(rowid, contact_name, phone_number, transcript) VALUES (new.id, new.contact_name, new.phone_number, new.transcript); END;"
];

// Columns added after the first release. ensureSchema adds any that are missing,
// so an existing database upgrades itself on the first request after a deploy.
const ADDED_COLUMNS = {
  segments: "TEXT",                         // JSON [{start,end,text,status}] per transcribed piece of audio
  partial_note: "TEXT",                     // set when the transcript is known or suspected to be incomplete
  needs_audio: "INTEGER NOT NULL DEFAULT 0", // 1 = waiting for the Apps Script to send the audio again
  prev_status: "TEXT",                      // status to go back to if a re-transcription fails
};

const schemaReady = new WeakSet(); // per database binding
async function ensureSchema(env) {
  if (schemaReady.has(env.DB)) return;
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  const { results: cols } = await env.DB.prepare("PRAGMA table_info(calls)").all();
  const have = new Set(cols.map((c) => c.name));
  const missing = Object.entries(ADDED_COLUMNS).filter(([name]) => !have.has(name));
  for (const [name, type] of missing) {
    try {
      await env.DB.prepare(`ALTER TABLE calls ADD COLUMN ${name} ${type}`).run();
    } catch (err) {
      // another request may have added it at the same moment
      if (!/duplicate column/i.test(String(err.message))) throw err;
    }
  }
  schemaReady.add(env.DB);
}

const SERVER_INFO = { name: "call-transcripts", title: "Phone Calls", version: "1.2.0" };
const ICON_PNG_HEX = "89504e470d0a1a0a0000000d4948445200000080000000800806000000c33e61cb0000100049444154789cec5d099815c5b5feabef9d6118601c40041710051c31a2201af334899ab86062f23401a3519318f7449360d48090f7f814a3c667d4e4f3693451f1d36744c3332f1a544c5ce216594502228318f67d676096dbf5aaf7aaeaeaeeeabe3d0b38e7fba0a7baabbbaafb9cfffce75455f72da21564d211b38e3449e96b8681c361d27e06415f4acdbeacdc0fa659cdca4c289c0d855da6a6bda57e39d84f34ca8495bdfd4ed9da4ffcebc23f1e5d16db57d5231aed87fba3ee7764fb0d06b096fdb5ce20742ddbb18eedfeb85432a67db9fe474b91b310e424b6d20d7a01ebf818027a14b12f4ee128da51b6aa1cec83bf3fa8231989b7cf7b789165762de25ddb53865ce6daf78dc6a92794ddfe18f27e4f895e9b8ab2550fa1b2db2ea1c2f543cfc36fdf291bf671cc63e74d252da5a927d7df948b31946d001386ce3e8f75741243dc3122b29390572ef2d508d2a9971ef9ea7eabee23b95e54fbf27d24f67b167beeb79df4d1cf9e431992d900261e39f35476faaf98858e085b300404ab911eae1742be6bf9914897cf7391efb74339a409f4a0407a04c20d653d84afabf404c9f717ff7cf8fb8ff498b3a8698effb725e35f4106496d00e38e9a39a260da8a3f9520e04422233fb2dc9a9c8f1c91afdb7eb99c9fc683b9cf1be08ccd2d13fa0abbd6f813174f9c851492ca00c6d7cd99c810710b6b9ca8b8bbe371be5ba71cce171e7614d2697ace2722c747235f7e96b19e96b2edcf472e9e701b3445cb00268d9c55ddb8933cc4947211603a9d139404b43ee787a3fad6e37ca2d59f36e6fc70fb709fbf5466db274bdd4b571e3f7b5203ca35809beae61c5441e8f3eccf11ba5c1ec76941d9ed7c1ce787389e473e8760a9bc6f737ef27374fb35d7a4e639c72d9eb43a46bd6e7b1132e1c8b9271540673aca377df72c346e3d34c17d9b4227bdfa4ebd7099848e9b819be6cae2c397381fe198804790a76c1592480cd2822d95385f54be7d1d70c6e819a9b4753ca6e9d773ce13cb417d533476d088b2193c7fee38ebe78802c1cc79837f3e023112e901c61ef276d7aeddaade26c41cee35285b5ec7e3fcbd3bcf573fcb784f9bf4fc59237377eedc71f2492befd9add273a40760ca9fc26e62b877d33ed2a040a6b29c02f90422f289583f8c742e400b79060ea9d040be852042a33d07780f21190341623912f9a1e394f3186a4f22225df244519e82d21135dd7a3c1aa567a5014c3872ce3876716b442fdc39843b27d7231ea2a0ba490adebd09e751b11e81299e47a587e2bb67d17d13a5d229f8008d3706f13caabe8e648c3c4d11c1c8ddfe00b12070ce17eb11a91e71e9d54bf58030b8847a2e4dfbd7f18dc2fcd6a223268c53e93a4401e307cf39ca289af359070b9d79beba3fe545fb19f37cde1379cae53ca30f2a4ef97efbb65198a562911e3364e1ed0b797d873c8051a46c900705c25d9444b91745d9884438153b49829b208a32ef0e054ee791af70bf89c887b41f61a447d10ae1902bc410bc2782d43e10422c421e830f80a5d805dcf3f7ce17ca51c8a782b1b00e154a25f2ab90bef9c2c4a1b3ce65173bab7d38dfccc0f93423e773c779a4e5c9f9548ef6a9021481918b65b79eccf942590d427f9c0681b1387ab4cf3febc3ba71a3940670dde0255d58ddfb04f7e25992d4b968ce4f40bef23caeccd38952491cd27825a4e67c73efe47c502dce571981b765aefd6e8a31859001d414b78d659506c86e079476e6f92448ed5448158dbb8df27c45d950945de4c3f304ecfe8eaa1f7ad8759edeedba2cf0eb53289696b28a3d78e5ebe499bc3110c1e2a868449c47e9ccf3f3cbf395cf5bd19f2016b0fe99db51553178c8dcdb37d8fb0b859691acb33d3af37cc918480ace6fa73c3f81f311289f950dc70088811a34377fc6da6bb8ff8de21128772e9af3693acea7b433cf0f95cbcff3e3383f40bef57f607ccc0b8cf20d801d1c958df32952713e875ca2b8499fcb9107e7d34ece778d23403e3301ab6f867dfd736dd55b6bf9a8515ae475029cf2db9ff3dd3ae5703e24b70d8a5c389f881c2f3f9f8ec5f98ef2e5b261b60c35a8d1722e8ff4ce3c3fbeec23af63e6f98842be5d3f88016c3a308bc6b945561e6eefe43a47a02ac771befae643d7a1a6a4141ac1f99212146e5c1dd851848773a963f8241c5086391f8111423242c483c0374e6ebf92e6c0d126a4eb42aa07e93a3146c01b83772322e753a7cc198335d967d5afedccf3f77dcee791ef2aca3ab9b6c84eeec7770aa14e6a209fd298b17cb94c5dce773a0f5e495efb51ee57857c2002f9809a56208ced03620c0148468308109088fd70efcf377e3e760157e6da13ca51c8e73c8cc2738490ef219d70ee5fd8dac6c20c80d07e7e672310e4cdaa896e56ed7655e757762fe2f033fa62e0697db1df806a54f7e9828aea2274c5be8cbb4d168abc45afddf2da371b9ad0bc7e079a966fc1f6571763dbcb6cd28eed733c047194ea5edf47ba5c361072f31494db0fc02fb3fa05f423b71ef9d61e76a12e3a512afcbfc396a78aeeab7b5560f8a58763e8e8fe2876319055f415d0decacfa70f569be69e666c7e6636363dfa16cc2dbbb8e79f10ed93e06f21fae7914f4ccf4535925bebdea402b770882e673e7fe017fae04b771c838aae056495bd0ff95e8ff36bb7b4ab11ab6f7a16bbdeaee7b22ba73d15f2a9e4e6a97b3ca827960d3930c9633effd84b0ec559f78d284bf9aa87112d1d01f99694d70f8270bb856e5dd0fffe8bd0f3c2133370bec96de107827cd9c83bcf1ff29503f1b9b17528f741e84b47407efe7d90a5ef4da35073f6d110914f63f37c489c0f1218835736bc683b8ff9fc5e8757e34b9387210fd9bb905f7e9b3aedf6fbc5687419b83f04e42bf37c19f99207e0b6469e79fef13f188c7264ef437edb4bafab4fd5cef303a45b6567bcc2f7046ec068e4b586af7aff4a96e61d8072e5d3cef949d2edcc6120fb5565e67c7feb1a81919df3b9d881fd31e8cc7e2024db63ece47c7db19e718fb386212be77b46435dda3052713ea591f3f9879fd10fe54827e7eb0a45b7d38fceccf91e6d78c663a4e27cce13c8d943efba1aa4954ece4f2b4e1fba1c715066cef703477702b098d7d87e3163ceff69e3fcec12b44daa2ad463fbfeacae299609af74ea1b04e56380b2e7f3534827e7a715b17d5259c8ccf9a25130e0e6359f9f563e6d9c9f5da8f262441adbe795ca6f3da4cbc8f7b380bce6f375a493f3d38a5af9de311dce87c4f9c2d6b03d003271be3c9faf2b9d9c9fb16de96259393f283b01a4a19be78738dff7045e2790d383e8e4fc24e53b35b2717e90123aa96331f6ad5c8865b8c8176300caad6c89964eced79564e5dbbb43884790ea25223f88e58ae1953c8a65555259b9f64ed549a4516974cd9d9b285e7e780f96ce6eb1cb83461671e61555e8de3bfe51a7477e7b988bdc074e62bbe3e8c95766449e4f25e407f5cd2006d0e77cea73bebf6e3f2106c803f92f3eb8070b5e6df6cbf35f69865902464fe88af2da4dd78f24690be4fb873372bea77caf5c14914f8024a4476da5bee7817c4f96bcd7a2b58f6f5f5f3a7ab41f75862980540bf9dcd68b1d8af2fbf95179beccf9323dc89227e737eea25afbf4db0da4b4610736ddf71276bfbb14a54d3bd15652e8dd1dd59f1b84de3f3e13853e3d82039a37e07980a43c5fe67c795b8cff260fd1f004a6ef01f2467e5ac9c2f91bef9e8e5d2f7d80b616cbd876bcf03e688b89be778c7176a6b9810c9c0f616d2075b200dd3c3f69ddbedf2faddeb78ef2ad60f12529583c2b3658a4d8fdd612b4a73478eda7745d59385ff000ee48623133e7cbab81b5a5f5903f3d22581c23048b1d81f32549cb5b4066ce97df1b30f27a3fbf3d91ef49da60d192ae270f417b4a75c6f6bdf97c07f9a66b0c6622e7cb2f8d14b5f3fc08e4538d914047c2cacf9adffb0f412ac7078bea3c7fff9f9e0d5234da2f08fcc999c8249a793e4d7863a8a89be7cb9c1f180145f25c80fa7896fcbe3c09f7c38ac00f983c1a3a92c15347b75ddec5b4f37c19f9e24a222b08ccc8f9a17705756f9c932c2e3b9b74fcb1fdd49291f3e577048bba797e14f2e52c20f6c6254993dfb7a77428e47b97d1ccf3f97703a9a25cccccf9f2794937fea994d651be732dbd3c3f0af954f0001a797e14f21d43a3f137de81a5b54702f9604f18f12b57149c0f0dce076f0c243606d044beff79574ff62ee4b7f648a030e277e718e426241be7076547bfc57cbec9c3a75af94a9e5e53256d3512d8906b3b543bcf5723dfcd12883412980ef9720cd011c6f63f0de2dea7669e2f233f08189dad4124ce4ffc0227a4fd80d68aa0b4d2dac8f7a4ad4602ab7369c7533e34f37cd3457ef4bb82459289f309e2d603942b6d89fcd61e092c7bc4cf172a3e18928df385f10222af08d2e67c7e0a99eed5ded78accfb6a8e04aaa51553bda83600ed3c5fe67c7ff0c8dd1a797d87efd3296da87ce9dafe7701040f80d056e3fb00d0e47c40fca58de078d618a04b37a2b52f5aca333c974a334afb29dfde9591f3d5df0788433e34bfb79f41867cb6a8b5afe3491b293fd64229f8ef03843d80a71fe9bd016f2591fb775137cf97395f8e1db2c8a8abab6014105ac1d3dac23f536f24b0a18c2030ffd1bee4e7493272bebc9228764550dc1c41287bc8203dd8bcff37c7e537f56bd1873c99944429d648e0ce324702f31ded8b76fb622dbd3c3fe9bd0123afdfd54b2bade135877cb610bb4fe551f31ca12bff5a7acab7ab64e47c9f36dc154445ed3c5ff10651fc6c604ce753d5d637aeb36d4ab1561895ecf2a0918536a1947c84a67c30542bcfe7395fb586b0a89be787c60b209ea72bad122fb9d23d8252e2dab446e876e63419947db42f430c9591f34331004944be9af3436b0835243df25bd35c1cf14602f30a02d38bbedb97cfcbc2f9f21ac262549e4f1238dfab67df808607c8a64ae7ba59823bdd36a3d704b66f9e9f2469bf0f10de3aed1bb9fdae5e5c6791465ca3e22429b8cb5f3a429e9f247a793e8f7c70c8a7c409208bba79beccf9f26fec44491ecf2e6d70575e9badabfc8d9b36e3efefbe87b9f31660d9f21558be723596af58651f1bd0ff601ccafe0d1c7008461c7b344e3df944f4ec59abbe90918df379bab0eeb59899f3e5f3149217e777cf79bc20be0f9ce4a4fcb5ebd6e3e1294fe1e5bfbd81858ba353c5050b17dbff7839e6e8a138e3b42fe0fb178f41bfbefca778f3fa3e00b2717e508632062887f3b34a4743bea5f8df3cf4281efb9f67b1674f23b2c8fc058bec7ff73f3c05975e3406d75ef95ddb10b272bea77c7f3dc1d4bac7291f00f20161d26f03f1c74f9f73b9dfe9f4c8cf47b2eb2c5fe5e7a1f828a9aaea621bc2b717fd1dbdaa0a3179befa0d21f997438cbc7e4bd7939c29534bca8aa572567e535333eefaf56ff1e0234fe6ae7c4bac6b3ef0fb27f09b4f36a3d90bd4438837b9ad7556c0f9f24aa26266ce97b6e69e1614aad2cce4b54d9e9fdc074ecaeccee62d5bf1edcbafc3cc39efa3b565eaea1df8685713ee3fb60f7a5619da9c1f78026758d848e27c07f99c51c0ad471ce47b9ea069f36ea4977d673ebfb9b919175e766d9b28df9379db1a71ddfc0d9c279091afe07ccf13b8238986769e1f51b60713d876e7924d9add0ee7f96d2ff9077ce326dd815973e7a3ad65ced646fce2c32d91797ef0e97813aadf1832b272dba2554100000d00494441547e5076b65bdf5d81b6928e847c4b1e79e26916f03d83f692a757ecc21f96efd0e27c79eda091d76fe96e4e3480f6463dd01aca5fb7612326de7a17da5bee5cb41d1b9a4a0ef27dcea791c877b6106380349cef1b8b5bdef3c9566c796f654237f71dcef7e497f73e80c6a6a6c47abd7ad5e2bebb2763c98277307fe6dff0dd8bcf479ed2c8f4fe70fdce44ce17561059c6f1a7badf519d3c9f1f1770de1b10cbd6b66bff1a8c7cf64218957c36b0efe5f99e7cb27c254e38ed1c98a69958f795e9cfe0b8e1e24fea5df9c31bf1ecb43f232fb17e9d77c619bdd0b7ba108af6a9b0b5f6bbe30059395f2e5bf5f6acd88afa497f45ded211916fc95dbf7e504bf916da65e55b72f79d9370f041e5fdd6122f9617b87f71432cf2e5df1832b272be57265279c3f4c55876f71bd857399f179da8df72fd3f1f7fbdf2588feeddf0c843f722ebafada9e4bd8dcdb19cef6dbd5f1c31b439dfddca3140d82350ac7d622e3ebcee4f28352473639c7454e45bf251fd32d47ffc4962bd3b264fb48d204a4e18391c3ffee1e5c84b96ed2c61e9f69600f944e27ce977050ddd3c3f84fcd071de63b0b4f0cd65f860f4e3d8f6cebfd0f6d2bacab7e42f3392a96e189bc91b7dde3989f5aebde632e4297f5d630d41bb9c4f68f0db422440bea7cf6036d0aee3713e5f4624e7cbfbe5f39ad66cc7473ff8237a8c3c18359f1d80ee47f74397836b51d1a71b8ceacac81b284f5fadaf7cab0d1df77fc6974f818ed4d474479eb2686b8bc2fd7334c0fdc6501132e2a53900aa98258cca12fcaf8d43f4243b67afc4aed92b826cc2eea6944af23f53eb1ef7da3f6aee7f404fa2954f9b4bd8f4ab69d8f1e77794b362c27cbabf741aea5935565e59ff4f24c921071f081d79f5f5b791a76c680c944da5adbc8ea028723e0d8d0886918f10e77ba390fe7b04f03c04b832b895437c990a65e21fe73c8c96442bbf65fd566cb8f931342e5e115e374f00d5fc3948fc77f836b6247fce4e673670c5ca55b86eeccdc85336eef1389f0becddfb8560d43605e8229f22cdec208f64df4308651a51b63c04711eb67b3c59a295bf67de32ac9ff0184adb768491cfc52c69bfbdbba92539c0ad5fba2cf6f8ea35ebf0d5f32ec17a369a98a76cdc63a5a601e7ab901f7c232847ce275cbd00c90895fd7a4ae43b9d3384729c442b7fdb53af63cb03cfb32a2505e2118174aaf5bdfd2eec824d347e0ce06fafbd197b7cd5ea3558b972355a43927e5710ae911b4899e707f5b987028ef343657bb021741c8ab2a128db9fac8f14b5f2cdc666acbf790ab6dcff67e6784aee7ef5fbf190900f09f920fc77f882b1f5de151548924ffeb502afbd11cdef560a78fee8af236fd9bf8a48d13e20fcca1877ff46963c3f182994399f86385f8d7cee9d43ff38150344be5f4a512bbf79e526acbeec3e34bcf141a0448d77e51ce407f3e932e743f200bd2bf516bffc67c244d1e449e3ecd5c0794a9fae24e07c776a582c07f76f44223f21cf17cb6e3d01e9d22c6384a708bb7bc7286ccf032f489445adfcddfff808ab2fbd072d9fac455ebfab47bd2f70fa6527c0ea53d433800f162cc2134ffd31f2f8febd7b61dad38fd8dbbca48fbd809a7b6f80d7af14f01a618483e37c33c4f9e1328510e085aec3d55322dfe99c6c04bc3188a2503edbb5e5f733b076ec43a0bbf7004481787feb727c99dfdb3fb29bfe4ba7e3264cf6d7feabe4f0c30ec50bcf3d89830eec1b3a56c1a8e6dfbf360a575e76090e1b38003a32b41709ddb78c7c2fd6b1766feb689cef21df1b1f0824ac7c735723d65eff3b6cfdfd4b1cd2bdfe86399fa6e07c7e3e5dfe26cfa9b535d09586ddbb71c5353f45a9548aac3364f06198f1976770d4d023fc7dfd1935bc36631a1e65f305774c9e80d9efbc8c87fefbbfec398438397d402192f325fadbc66200ba3639cf6f6bce0fea05414058f94d1fafc3eaefddc35cff8748fb7ebc0ee7c77d876f50f74a0cac8a1ecd9465e6ec799838e9ced83a07f63b00afbd3c0d77de361175470cc2f3d31ec7d03af18d636b68f9cd57ff0f23861fadbcc6613504837a2211f90e18b0d63abc36980d746e3633e7231fcef747063d652994bfebd5052cd8fb359a576d9438be7538df3702dfc8283e5f9b6e08f7b7bf7b3c71febfc8628b2bbe7f31de79fd05f43f441d1c5afb67bc3015575ff19dd0b133fa9358ce17c7396cdd7b1e2007ce475e9ccf8fbc89caa725139bef7b9e0dee4c016d6ce4940725e72327ce17e7d59d94f0a2836a5199722af75a36eaf78f997350ae18cc77ffe2969b71da2927fbfb2a0bc065c30a89c8f7560ffb06d0d1389f9fcfa69c0194b63760cdb5bfc5b6a7df70aea3c1f948c1f988e17caf3d7edb9f4d685d7c50f454af4aac17472efcce3578f7bdf28dc0922f9ff605ffef4b871ae8dd55423ceff95ca38077ff056600ac30afa371beb082c53580c6c5abb0fa927bd138ff6320c33771d2e6f9badfe1bbe2d05ee85e08e72a71b275eb367ced1b9760ca135351ae2c5cf491bdedcec6a5ae1e6e8491cf7f130826f8f7064c98f30adfabfdeac68241c75aa745c50086cff912f2e5d801e1b237b6cf2b39e07cb11e9faaf19c5bd1bf37d6ddf4188bf81bc0235f39abe79e27cfeaa9391fdc2089e923844470beb875ea57b27f07752d62c6c65d4823d6b7985f9af12a1a198d9df2c5939045feb970316e1c7f8b7dadbbbe6860581f92c0f9e03c81492b0ba51f16a66c9ebefdd2fdcf3c8f1deb472072b553a6429948c7a3ea85af03e57584685fe22ccf181a5eb7bee15382fff053e6f9e27501d5d878f07002e5cbab68f9f6c1b57b448f4a349a26e66e4bff2ea045054bea3fc6a9cc08ba74e9a27d9e358bf8cd0b2fb7bdc955c308be37aca07e7e0a6370efffbd9a71cbefb19f3fdbf76287e27c0e79c198b61ee7e795e753a8911fd5fe4f06f7c4c85a7d05f232ed4f7fc188cf9d618f18524a13eb5bca3fe71bdfc10a36b8f4c583096e38c1502b5be67cd7e339e3bfe68bd6b51c0330f05cc7e2fc8073e5356c6d95e7a7fd0e9f1506dc7b6c1f1c5895edd3355bb66cc58fae9f80cf9ff6f5d809a4b7de790fa79f7dbeadfc7e6c3ce8be2f19761f94d1bec4f9e0416c18b601b8bb2979bbeeae2dece07efcca1f5f79ca72d44a1e6f3edf14381f119c2f2f59a6891cafc7f951efc7ebffc64e7cbba19544eed69a22befdc32df6eb5ae5c8e0418761d499a761d86786a25bb76acc9af33efefee6bb98ed2e451b3384e096930d541421209f26dcbf7b1fdb6a6e5cde931da77e12fbf611bf1cc72e703b89e47c2a70be4e3d28ea07c8a7919cafe4dc881821f23a119c1f3a1e6a2f5dfb51e53f2cdf895bffb90dc96f0da4130b9c934f2ae0fc2389667fc2fd675a1f5f7bd3f23beceb79176e6c6ab8971d5cb7b7713e52707eda3c5f37e6e01fb6c7b9170cacc6f3a7f6c1e8fe55a820285bacb57ba3071b987e6e01dfe295cfb71fc3f95cccb37ebf06e35eefba42d7fe5177fbd56cf3008f7448c847c8130099906f507559409e7b9c73b75196ae463e15620025f2736a5f8d3ce7ef35bb9bf1f09206fc71f91efbed9d3452cd428a6fd519f8fe670a38b00732b5ef674d96b91ae635b537ac7a5069005331b530b0ae7e093bf930e53782ec5a9d9ccf737e52fbf275e66c6ac28bab1a317f7309db9b4d5899e38e66c72a6a2a095846895a36b870dc0104670f2ce0983e10af23b4abcdf98e7e0c2ce83160e570723e4a4a03b064e6d0db2e60759feaa89c2f3ffcac9c9f98e7a7e4fc28ce8d6b5f1d7ba8fb9fb57d221c33cfabb961f573bcbe0dd9004e5834e10f8cf31fedccf3d371bec0b98af679638f7b572f690d9fb0d5e0fce04b21748aac7ca501d85deadee72ad6c88cce3c3fbafd20bfa648f34d1e617651f1ae5ed21a3ee7bebde7189de7fbc6e5ec7fa5a647bf2b54ba561ac0f1b3af6a6e6a3147b313e7e7319faf1a5b57233f78186d319f2f6ecde0a1f2ed7bc8271ac8f7118f48e40bf74d64e47b4ae5ca2ae46bb44f3de326f48396cadddf2457cd6e56e93a3641797ff0a44350c03b4cb187b417e727731fd01e79fedec0f94cf9ab2a0d7262f5f52b2317241a889163eb27ad64e1e289ec6273db8bf39182f3db32cf6f33cee7db4fc7f9ef56148a27c4293fd1002c396ef1a4d54ddd8ccfb38a4f7674ce073a20e79300f999389f6f5f9ff39faed9b9df29ddc6fe6b0d128420852cac9b38813576ab01673941679e9fdc7fddf6f3c8f3d996396c7ae37e37acba079a92ca002cf9b06ec2f1ac33b7b37b3bbd3538bf33cf4fd77e70dc7c8516ccf1b5d7af99851492da003cf968c8b8d389416e074ac7f3c8a312e769239fe3dc44e42b3d811ef25bab7d24dc7f26e4c7b6e7dff72c56617ced8dcb5f4106c96c009ed40ffdd90514a51b5867468a018b0a79340874f8b2c2d2d5c8a7420ca0425e5eedab91e7a32db27da15dc2c700e2f9911e4cb37dd6ff9926f3c43d6f5cf9bf2843ca36004f161f3bf6e08a12469906bec23a7f3ab3cc9a4ececf95f3b7b0ed0c4a4bd32bcce2f4ee1396ad430e929b01c8523ffc4727b10ed7b134711035e820763383d94db22ded198f7415f293397f9fc9f30d6c61d9d65276fe52d6e65266104b0d6a2edc6fe227efa215e4ff010000ffff927bc006000000064944415403006bab82d979d239540000000049454e44ae426082";
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"> <defs> <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"> <stop offset="0" stop-color="#6D28D9"/> <stop offset="0.55" stop-color="#DB2777"/> <stop offset="1" stop-color="#F59E0B"/> </linearGradient> </defs> <rect width="256" height="256" rx="56" fill="url(#bg)"/> <!-- speech bubble --> <path d="M60 52h136a24 24 0 0 1 24 24v84a24 24 0 0 1-24 24h-76l-38 30v-30H60a24 24 0 0 1-24-24V76a24 24 0 0 1 24-24z" fill="#fff" opacity="0.96"/> <!-- waveform -> text lines --> <g fill="#7C3AED"> <rect x="62" y="104" width="12" height="32" rx="6"/> <rect x="82" y="88" width="12" height="64" rx="6"/> <rect x="102" y="98" width="12" height="44" rx="6"/> </g> <g fill="#DB2777"> <rect x="128" y="94" width="66" height="12" rx="6"/> <rect x="128" y="114" width="54" height="12" rx="6"/> <rect x="128" y="134" width="40" height="12" rx="6"/> </g> <!-- phone handset badge --> <circle cx="196" cy="190" r="40" fill="#111827"/> <path d="M181 172c3-3 7-3 9 0l5 7c2 3 1 6-1 8l-3 3c3 6 8 11 14 14l3-3c2-2 5-3 8-1l7 5c3 2 3 6 0 9l-4 4c-4 4-10 4-15 2-12-6-22-16-28-28-2-5-2-11 2-15z" fill="#fff"/> </svg> ';
const BILLING_URL = "https://platform.openai.com/settings/organization/billing/overview";
const DEFAULT_PROTOCOL = "2025-06-18";
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;
// gpt-4o-transcribe rejects audio longer than ~1500s; files we can't cut into
// pieces (not MP4/M4A) use whisper-1 above this.
const LONG_CALL_SEC = 1400;
// gpt-4o-transcribe stops writing at 2,048 output tokens and returns the text so
// far with no error. Hebrew runs ~2.9 characters per token, so that is roughly
// 10 minutes of speech. Long recordings are therefore cut into pieces of at most
// CHUNK_MAX_SEC (cut at the quietest moment after CHUNK_MIN_SEC), and every
// piece is checked against the limit.
const OUTPUT_TOKEN_CAP = 2048;
const NEAR_CAP_TOKENS = 1950;
const NEAR_CAP_CHARS = 5200; // used only if the API returns no usage numbers
const SPLIT_ABOVE_SEC = 300;
const CHUNK_MIN_SEC = 210;
const CHUNK_MAX_SEC = 270;
// Free Workers allow 50 outbound requests per invocation; leave room for Drive etc.
const OPENAI_CALLS_PER_RUN = 40;
// Cutting a long recording costs a few ms of CPU, and free Workers get 10 ms per
// run, so each cron run cuts only this many long calls (override with the
// LONG_CALLS_PER_RUN variable, e.g. on the paid plan). The rest wait 5 minutes.
const LONG_CALLS_PER_RUN = 2;
const AUDIO_EXT = /\.(m4a|mp3|mp4|wav|ogg|oga|webm|flac|mpeg|mpga|amr|3gp|aac)$/i;
const OPENAI_EXT = /\.(m4a|mp3|mp4|wav|ogg|oga|webm|flac|mpeg|mpga)$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) {
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><title>Phone Calls MCP</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" type="image/png" sizes="128x128" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png"></head><body>Phone Calls MCP is running.</body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    if (parts.length === 1 && ["favicon.ico", "icon.png", "apple-touch-icon.png"].includes(parts[0])) {
      const bytes = new Uint8Array(ICON_PNG_HEX.match(/../g).map((h) => parseInt(h, 16)));
      return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    }
    if (parts.length === 1 && (parts[0] === "favicon.svg" || parts[0] === "icon.svg")) {
      return new Response(ICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    }

    const route = parts[0];
    if (route !== "mcp" && route !== "upload" && route !== "ingest") return notFound();

    // Auth: token in the path (/mcp/<token>) or as a Bearer header.
    const pathToken = parts[1] || "";
    const header = request.headers.get("authorization") || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!env.MCP_TOKEN || env.MCP_TOKEN.length < 24) {
      return new Response("Server not configured: MCP_TOKEN secret missing or too short.", { status: 500 });
    }
    if (!safeEqual(pathToken, env.MCP_TOKEN) && !safeEqual(bearer, env.MCP_TOKEN)) {
      return notFound();
    }

    await ensureSchema(env);
    if (route === "upload") return handleUpload(request, env, url);
    if (route === "ingest") {
      if (parts[2] === "check") return handleIngestCheck(request, env);
      if (parts[2] === "done") return handleDone(env, url);
      if (parts[2] === "ack") return handleAck(request, env);
      if (parts[2] === "health") return handleHealth(env);
      if (parts[2] === "gone") return handleGone(request, env);
      return handleIngest(request, env, url);
    }
    return handleMcp(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => runSync(env, { log: true })));
  },
};

function notFound() {
  return new Response("Not found", { status: 404 });
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC over Streamable HTTP, stateless, JSON responses)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_calls",
    description:
      "List recorded phone/WhatsApp calls, newest first, with contact, number, direction, time (phone's local time) and duration. Use to browse calls by date or contact. Returns call ids for get_transcript.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        until: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        contact: { type: "string", description: "Part of the contact name or phone number" },
        limit: { type: "integer", description: "Max results (default 20, max 100)" },
        offset: { type: "integer", description: "Skip this many results (paging)" },
      },
    },
  },
  {
    name: "search_calls",
    description:
      "Full-text search across call transcripts (Hebrew and English; matches substrings, so prefixes like ו/ה/ב/ל are fine). All words must appear. Returns matching calls with a snippet around the match.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for in the transcript, contact name or number" },
        since: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        until: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        limit: { type: "integer", description: "Max results (default 10, max 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_transcript",
    description: "Get the full transcript and details of one call by its id, with [m:ss] time marks. If the transcript is incomplete it starts with a ⚠️ PARTIAL line saying which part of the call is missing.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "Call id from list_calls or search_calls" } },
      required: ["id"],
    },
  },
  {
    name: "sync_status",
    description:
      "Show the state of the transcription pipeline: how many calls are transcribed, pending or failed, the latest call, and recent errors.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_now",
    description:
      "Transcribe waiting recordings right away, up to max_files (otherwise this runs automatically every few minutes). Optionally retry one call by id.",
    inputSchema: {
      type: "object",
      properties: {
        max_files: { type: "integer", description: "How many recordings to transcribe now (default 3, max 5; stops after ~40s, the rest continue in the background every 5 minutes)" },
        retry_id: { type: "integer", description: "Re-transcribe this call id (e.g. one that failed or is partial). The call keeps its id and its current transcript until the new one succeeds." },
      },
    },
  },
  {
    name: "check_truncated",
    description:
      "Find older transcripts that are likely cut off (made before long calls were split into pieces). mode=list (default) only lists them; mode=mark labels them partial; mode=retranscribe transcribes up to `limit` of them again.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["list", "mark", "retranscribe"], description: "list (default), mark, or retranscribe" },
        limit: { type: "integer", description: "Max calls to re-transcribe in one go (default 10, max 50)" },
      },
    },
  },
];

async function handleMcp(request, env, ctx) {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const res = await handleRpc(msg, env, ctx, request);
    if (res) responses.push(res);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(batch ? responses : responses[0]);
}

async function handleRpc(msg, env, ctx, request) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...SERVER_INFO, icons: [
            { src: `${new URL(request.url).origin}/icon.png`, mimeType: "image/png", sizes: ["128x128"] },
            { src: `${new URL(request.url).origin}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
          ] },
          instructions:
            "Your recorded phone and WhatsApp calls (Cube ACR), transcribed. Times are the phone's local time. Use search_calls to find what was said, list_calls to browse by date/contact, get_transcript for the full text. Transcripts are machine-made and may contain errors, especially in names and numbers.",
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        let text = await callTool(params?.name, params?.arguments || {}, env, ctx);
        const alert = await getAlert(env);
        if (alert && params?.name !== "sync_status") text = `⚠️ ${alert.message} New recordings are waiting and will be transcribed once this is fixed. Tell the user. ${BILLING_URL}\n\n${text}`;
        return ok({ content: [{ type: "text", text }] });
      }
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        if (isNotification) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (method === "tools/call") {
      return ok({ content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true });
    }
    return fail(-32603, String(err.message || err));
  }
}

async function callTool(name, args, env) {
  switch (name) {
    case "list_calls":
      return listCalls(env, args);
    case "search_calls":
      return searchCalls(env, args);
    case "get_transcript":
      return getTranscript(env, args);
    case "sync_status":
      return syncStatus(env);
    case "sync_now": {
      let note = "";
      if (args.retry_id) {
        const row = await env.DB.prepare("SELECT id, status FROM calls WHERE id=?").bind(args.retry_id).first();
        if (!row) return `No call with id ${args.retry_id}.`;
        if (row.status === "expired") return `Call #${row.id} is older than the retention period and can't be re-transcribed.`;
        await requeue(env, [row.id]);
        note = `Call #${row.id} queued for re-transcription. It keeps its id, and its current transcript stays until the new one is ready.\n`;
      }
      const max = clamp(args.max_files ?? 3, 1, 5);
      const r = await runSync(env, { maxFiles: max, priorityId: args.retry_id, budgetMs: 40_000 });
      if (args.retry_id) {
        const after = await env.DB.prepare("SELECT needs_audio, status FROM calls WHERE id=?").bind(args.retry_id).first();
        if (after?.needs_audio) note += `The recording is no longer in temporary storage, so the Apps Script will send it again from Google Drive within ~5 minutes, and it will be transcribed on the run after that.\n`;
        else if (after) note += `Status of #${args.retry_id} now: ${after.status}.\n`;
      }
      return note + formatSyncResult(r);
    }
    case "check_truncated":
      return checkTruncated(env, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Queue calls for (re-)transcription without losing what they have now.
// A pushed recording whose audio is no longer in KV is requested from the
// Apps Script; runSync notices that on its own when it gets to the row.
async function requeue(env, ids) {
  await env.DB.prepare(
    `UPDATE calls SET
       prev_status = CASE WHEN status IN ('done','partial') THEN status ELSE prev_status END,
       status='pending', attempts=0, error=NULL, needs_audio=0
     WHERE id IN (SELECT value FROM json_each(?)) AND status != 'expired'`
  ).bind(JSON.stringify(ids)).run();
}

// Transcripts made before long calls were cut into pieces stop at the model's
// 2,048-token limit, which is about 5,000-6,500 characters of Hebrew. Any
// gpt-4o transcript that long, from a call over 7 minutes, is suspect.
const SUSPECT_SQL = `status IN ('done','partial') AND segments IS NULL AND needs_audio=0
  AND model LIKE 'gpt-4o%' AND duration_sec >= 420 AND length(transcript) >= 4500`;

async function checkTruncated(env, args) {
  const mode = ["list", "mark", "retranscribe"].includes(args.mode) ? args.mode : "list";
  const limit = clamp(args.limit ?? 10, 1, 50);
  const { results } = await env.DB.prepare(
    `SELECT id, contact_name, phone_number, channel, direction, call_time, duration_sec, status, length(transcript) chars
     FROM calls WHERE ${SUSPECT_SQL} ORDER BY call_time DESC`
  ).all();
  if (!results.length) return "No older transcripts look cut off.";
  const lines = results.map((r) => `${fmtCallLine(r)} | ${r.chars} chars`);
  const head = `${results.length} transcripts from before the fix are likely cut off (made in one piece, call over 7 minutes, near the model's output limit):`;
  if (mode === "list") {
    return `${head}\n${lines.join("\n")}\n\nUse mode "mark" to label them partial, or "retranscribe" to transcribe them again in pieces (up to ${limit} per call; costs about $0.006 per minute of audio).`;
  }
  const note = "Transcript is likely incomplete: it was made before long calls were split into pieces and probably stops before the end of the call.";
  if (mode === "mark") {
    await env.DB.prepare(`UPDATE calls SET status='partial', partial_note=?, exported=0 WHERE ${SUSPECT_SQL}`).bind(note).run();
    return `Marked ${results.length} transcripts as partial.\n${lines.join("\n")}`;
  }
  const pick = results.slice(0, limit);
  await env.DB.prepare(`UPDATE calls SET partial_note=? WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(note, JSON.stringify(pick.map((r) => r.id))).run();
  await requeue(env, pick.map((r) => r.id));
  // they need their audio again from Drive
  await env.DB.prepare(
    `UPDATE calls SET needs_audio=1, status=COALESCE(prev_status, status) WHERE id IN (SELECT value FROM json_each(?)) AND source='push'`
  ).bind(JSON.stringify(pick.map((r) => r.id))).run();
  return `Queued ${pick.length} of ${results.length} calls for re-transcription. Each keeps its id and current transcript until the new one is ready; the Apps Script sends the audio again over the next runs.\n${pick.map((r) => `${fmtCallLine(r)} | ${r.chars} chars`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function dateFilters(args, where, binds) {
  if (args.since) {
    where.push("call_time >= ?");
    binds.push(`${args.since}T00:00:00`);
  }
  if (args.until) {
    where.push("call_time <= ?");
    binds.push(`${args.until}T23:59:59`);
  }
}

function fmtCallLine(r) {
  const who = [r.contact_name, r.phone_number && r.phone_number !== r.contact_name ? r.phone_number : null]
    .filter(Boolean)
    .join(" · ");
  const when = r.call_time ? r.call_time.replace("T", " ").slice(0, 16) : "?";
  const dir = r.direction === "Incoming" ? "נכנסת" : r.direction === "Outgoing" ? "יוצאת" : r.direction || "";
  const dur = r.duration_sec != null ? fmtDuration(r.duration_sec) : "";
  const status = r.status === "done" ? "" : ` [${r.status}]`;
  return `#${r.id} | ${when} | ${who || "unknown"} | ${[r.channel, dir].filter(Boolean).join(" ")} | ${dur}${status}`;
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function listCalls(env, args) {
  const where = ["status != 'expired'"];
  const binds = [];
  dateFilters(args, where, binds);
  if (args.contact) {
    where.push("(contact_name LIKE ? OR phone_number LIKE ?)");
    const c = `%${args.contact}%`;
    binds.push(c, c);
  }
  const limit = clamp(args.limit ?? 20, 1, 100);
  const offset = Math.max(0, args.offset ?? 0);
  const { results } = await env.DB.prepare(
    `SELECT id, contact_name, phone_number, channel, direction, call_time, duration_sec, status
     FROM calls WHERE ${where.join(" AND ")}
     ORDER BY call_time DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all();
  if (!results.length) return "No calls found.";
  const more = results.length === limit ? `\n(more may exist: use offset=${offset + limit})` : "";
  return `${results.length} calls (times are the phone's local time):\n` + results.map(fmtCallLine).join("\n") + more;
}

async function searchCalls(env, args) {
  const q = String(args.query || "").trim();
  if (!q) throw new Error("query is required");
  const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const longWords = words.filter((w) => [...w].length >= 3);
  const shortWords = words.filter((w) => [...w].length < 3);

  const where = ["c.transcript IS NOT NULL", "c.status != 'expired'"];
  const binds = [];
  let from = "calls c";
  if (longWords.length) {
    from = "calls_fts f JOIN calls c ON c.id = f.rowid";
    where.push("calls_fts MATCH ?");
    binds.push(longWords.map((w) => `"${w.replace(/"/g, '""')}"`).join(" AND "));
  }
  for (const w of shortWords) {
    where.push("(c.transcript LIKE ? OR c.contact_name LIKE ?)");
    binds.push(`%${w}%`, `%${w}%`);
  }
  dateFilters(args, where, binds);
  // dateFilters adds unqualified column names; qualify them
  const whereSql = where.join(" AND ").replace(/(^|\s)call_time/g, "$1c.call_time");
  const limit = clamp(args.limit ?? 10, 1, 50);

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.contact_name, c.phone_number, c.channel, c.direction, c.call_time, c.duration_sec, c.status, c.transcript, c.partial_note
     FROM ${from} WHERE ${whereSql} ORDER BY c.call_time DESC LIMIT ?`
  )
    .bind(...binds, limit)
    .all();
  if (!results.length) return `No transcripts match "${q}".`;

  return (
    `${results.length} matching calls for "${q}":\n\n` +
    results.map((r) => `${fmtCallLine(r)}${r.partial_note ? "\n  ⚠️ PARTIAL: " + r.partial_note : ""}\n  …${snippet(r.transcript || "", words)}…`).join("\n\n")
  );
}

function snippet(text, words, radius = 160) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const w of words) {
    pos = lower.indexOf(w.toLowerCase());
    if (pos >= 0) break;
  }
  if (pos < 0) return text.slice(0, radius * 2).replace(/\s+/g, " ");
  const start = Math.max(0, pos - radius);
  return text.slice(start, pos + radius).replace(/\s+/g, " ");
}

async function getTranscript(env, args) {
  const id = Number(args.id);
  if (!Number.isInteger(id)) throw new Error("id must be an integer");
  const r = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(id).first();
  if (!r) return `No call with id ${id}.`;
  if (r.status === "expired") return `Call #${id} is older than the retention period; its transcript was deleted (the audio is still in Google Drive).`;
  const head = [
    fmtCallLine(r),
    `File: ${r.file_name}`,
    r.model ? `Transcribed with ${r.model} at ${r.transcribed_at} UTC` : null,
    r.error ? `Error: ${r.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (!r.transcript) return `${head}\n\n(No transcript yet: status is ${r.status}.)`;
  const notes = [];
  if (r.partial_note) notes.push(`⚠️ PARTIAL: ${r.partial_note} Do not treat this as the whole call.`);
  if (!["done", "partial"].includes(r.status)) {
    notes.push(r.needs_audio
      ? "(Re-transcription is waiting for the recording to be sent again; showing the previous transcript.)"
      : `(Re-transcription ${r.status === "error" ? "failed for now and will be retried" : "in progress"}; showing the previous transcript.)`);
  }
  return `${head}\n${notes.length ? notes.join("\n") + "\n" : ""}\n${renderTranscript(r)}`;
}

// Transcript text with a [m:ss] mark at the start of each piece of audio
function renderTranscript(r) {
  let segs = null;
  try {
    segs = r.segments ? JSON.parse(r.segments) : null;
  } catch {
    /* plain text */
  }
  if (!Array.isArray(segs) || !segs.length || segs.every((s) => s.start == null)) return r.transcript;
  return segs
    .map((s) => {
      const t = s.start != null ? `[${fmtDuration(Math.round(s.start))}] ` : "";
      if (s.status === "failed") return `${t}[not transcribed: ${fmtDuration(Math.round(s.start))}–${fmtDuration(Math.round(s.end))}]`;
      return `${t}${s.text}${s.status === "truncated" ? " [cut off]" : ""}`;
    })
    .join("\n\n");
}

async function syncStatus(env) {
  const { results: counts } = await env.DB.prepare(
    "SELECT status, COUNT(*) n FROM calls GROUP BY status"
  ).all();
  const latest = await env.DB.prepare(
    "SELECT id, contact_name, phone_number, channel, direction, call_time, duration_sec, status FROM calls WHERE status='done' ORDER BY call_time DESC LIMIT 1"
  ).first();
  const { results: errors } = await env.DB.prepare(
    "SELECT id, file_name, error, attempts FROM calls WHERE status IN ('error','skipped') ORDER BY id DESC LIMIT 5"
  ).all();
  const { results: partial } = await env.DB.prepare(
    "SELECT id, contact_name, phone_number, channel, direction, call_time, duration_sec, status, partial_note FROM calls WHERE status='partial' ORDER BY call_time DESC LIMIT 5"
  ).all();
  const waiting = await env.DB.prepare("SELECT COUNT(*) n FROM calls WHERE needs_audio=1").first();
  const suspect = await env.DB.prepare(`SELECT COUNT(*) n FROM calls WHERE ${SUSPECT_SQL}`).first();
  const alert = await getAlert(env);
  const lines = [
    ...(alert ? [`⚠️ ${alert.message} (since ${alert.since} UTC) ${BILLING_URL}`] : []),
    "Calls by status: " + (counts.map((c) => `${c.status}=${c.n}`).join(", ") || "none yet"),
    `Retention: ${env.RETENTION_DAYS || 120} days. Model: ${env.TRANSCRIBE_MODEL || "gpt-4o-transcribe"}.`,
    latest ? `Latest transcribed call: ${fmtCallLine(latest)}` : "No transcribed calls yet.",
  ];
  if (partial.length) {
    lines.push("Partial transcripts (incomplete; newest first):");
    for (const p of partial) lines.push(`  ${fmtCallLine(p)}: ${p.partial_note}`);
  }
  if (waiting?.n) lines.push(`Waiting for the Apps Script to send the audio again: ${waiting.n}.`);
  if (suspect?.n) lines.push(`Older transcripts that are probably cut off: ${suspect.n} (see check_truncated).`);
  if (errors.length) {
    lines.push("Recent problems:");
    for (const e of errors) lines.push(`  #${e.id} ${e.file_name} (attempts ${e.attempts}): ${e.error}`);
  }
  return lines.join("\n");
}

function formatSyncResult(r) {
  const lines = [`New recordings found by Drive pull: ${r.discovered}. Transcribed now: ${r.transcribed}. Failed: ${r.failed}. Still pending: ${r.pending}.`];
  if (r.expired) lines.push(`Expired (older than retention): ${r.expired}.`);
  for (const e of r.errors) lines.push(`  ${e}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sync: Drive -> D1 -> OpenAI
// ---------------------------------------------------------------------------

async function runSync(env, { maxFiles, priorityId, log, budgetMs } = {}) {
  const started = Date.now();
  const result = { discovered: 0, transcribed: 0, failed: 0, pending: 0, expired: 0, errors: [] };
  const retention = Number(env.RETENTION_DAYS || 120);
  const batch = maxFiles ?? Number(env.BATCH_SIZE || 4);

  // 1. Retention: drop transcripts (and personal details) of old calls; keep the
  //    Drive id so the file is never transcribed again.
  const cutoff = new Date(Date.now() - retention * 86400_000);
  const cutoffLocal = cutoff.toISOString().slice(0, 19);
  const exp = await env.DB.prepare(
    `UPDATE calls SET status='expired', transcript=NULL, segments=NULL, partial_note=NULL, contact_name=NULL, phone_number=NULL, error=NULL, needs_audio=0
     WHERE status != 'expired' AND COALESCE(call_time, created_at) < ? RETURNING id`
  ).bind(cutoffLocal).all();
  result.expired = exp.results.length;

  // Recover rows stuck in 'processing' (e.g. a run that was killed)
  await env.DB.prepare(
    "UPDATE calls SET status='pending' WHERE status='processing' AND transcribed_at < datetime('now','-30 minutes')"
  ).run();

  // 2. Discover new recordings in Drive
  let token = null;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON && env.DRIVE_FOLDER_ID) {
    try {
      token = await googleAccessToken(env);
      result.discovered = await discoverDriveFiles(env, token, cutoff);
    } catch (err) {
      result.errors.push(`Drive: ${err.message}`);
    }
  }

  // 3. Transcribe pending recordings, newest first. Pushed recordings (from the
  //    Apps Script) wait in KV; Drive-pulled ones need a Google token.
  {
    const sources = token ? ["push", "drive"] : ["push"];
    const { results: todo } = await env.DB.prepare(
      `SELECT * FROM calls WHERE source IN (SELECT value FROM json_each(?))
         AND (status='pending' OR (status='error' AND attempts < 3)) AND needs_audio=0
       ORDER BY (id = ?) DESC, call_time DESC LIMIT ?`
    )
      .bind(JSON.stringify(sources), priorityId ?? -1, batch)
      .all();

    const budget = { openaiCalls: 0 };
    const maxLong = Number(env.LONG_CALLS_PER_RUN || LONG_CALLS_PER_RUN);
    let longCalls = 0;
    for (const row of todo) {
      if (budgetMs && Date.now() - started > budgetMs) break;
      // long calls take several OpenAI requests; leave them for the next run
      // rather than go over the Worker's per-run request limit
      if (budget.openaiCalls && budget.openaiCalls + estimateRequests(row.duration_sec) > OPENAI_CALLS_PER_RUN) break;
      const isLong = !row.duration_sec || row.duration_sec > SPLIT_ABOVE_SEC;
      if (isLong && longCalls >= maxLong && row.id !== priorityId) continue;
      if (isLong) longCalls++;
      // claim the row so overlapping runs don't double-process
      const claim = await env.DB.prepare(
        "UPDATE calls SET status='processing', transcribed_at=datetime('now') WHERE id=? AND status IN ('pending','error')"
      ).bind(row.id).run();
      if (!claim.meta?.changes) continue;
      try {
        if (row.source === "push") await processPushedRow(env, row, budget);
        else await processDriveRow(env, token, row, budget);
        result.transcribed++;
        if (result.transcribed === 1) await clearAlert(env);
      } catch (err) {
        if (err.halt) {
          // OpenAI account problem (no credit / bad key / rate limit): put the row back
          // untouched so it doesn't burn its attempts, and stop this run.
          await env.DB.prepare("UPDATE calls SET status='pending', transcribed_at=NULL WHERE id=?").bind(row.id).run();
          if (err.alert) await setAlert(env, err.alert);
          result.errors.push(err.message);
          break;
        }
        if (err.needsAudio) {
          // Not a failure: wait for the audio. A call that already has a
          // transcript keeps showing it, with its previous status.
          await env.DB.prepare(
            `UPDATE calls SET needs_audio=1, error=?, transcribed_at=NULL,
               status=CASE WHEN transcript IS NOT NULL AND prev_status IS NOT NULL THEN prev_status ELSE 'pending' END
             WHERE id=?`
          ).bind(err.message, row.id).run();
          result.errors.push(`#${row.id} ${row.file_name}: ${err.message}`);
          continue;
        }
        result.failed++;
        result.errors.push(`#${row.id} ${row.file_name}: ${err.message}`);
        const skipped = err.skip === true;
        const final = skipped || row.attempts + 1 >= 3;
        // A failed re-transcription never removes the earlier transcript: once it
        // gives up, the call goes back to its previous status.
        const status = final && row.transcript && row.prev_status ? row.prev_status : skipped ? "skipped" : "error";
        await env.DB.prepare(
          "UPDATE calls SET status=?, error=?, attempts=attempts+1, transcribed_at=NULL, prev_status=CASE WHEN ? THEN NULL ELSE prev_status END WHERE id=?"
        ).bind(status, String(err.message).slice(0, 500), status === row.prev_status ? 1 : 0, row.id).run();
        if (row.source === "push" && (skipped || row.attempts + 1 >= 3)) await env.AUDIO?.delete(audioKey(row.source_id));
      }
    }
  }

  const p = await env.DB.prepare(
    "SELECT COUNT(*) n FROM calls WHERE (status='pending' OR (status='error' AND attempts < 3)) OR needs_audio=1"
  ).first();
  result.pending = p?.n || 0;
  if (log) console.log(JSON.stringify(result));
  return result;
}

async function discoverDriveFiles(env, token, cutoff) {
  const files = [];
  let pageToken;
  const q = `'${env.DRIVE_FOLDER_ID}' in parents and trashed = false and createdTime > '${cutoff.toISOString()}'`;
  do {
    const u = new URL(`${driveBase(env)}/files`);
    u.searchParams.set("q", q);
    u.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, size, createdTime)");
    u.searchParams.set("pageSize", "1000");
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const sidecars = new Map();
  for (const f of files) if (/\.json$/i.test(f.name)) sidecars.set(f.name.replace(/\.json$/i, ""), f.id);
  const audio = files.filter((f) => AUDIO_EXT.test(f.name) || (f.mimeType || "").startsWith("audio/"));
  if (!audio.length) return 0;

  // Which ones do we already know?
  const known = new Set();
  const ids = audio.map((f) => f.id);
  for (let i = 0; i < ids.length; i += 500) {
    const { results } = await env.DB.prepare(
      "SELECT source_id FROM calls WHERE source_id IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify(ids.slice(i, i + 500))).all();
    for (const r of results) known.add(r.source_id);
  }

  const fresh = audio.filter((f) => !known.has(f.id));
  const stmts = fresh.map((f) => {
    const meta = parseCubeFileName(f.name);
    return env.DB.prepare(
      `INSERT OR IGNORE INTO calls (source, source_id, file_name, contact_name, phone_number, channel, direction, call_time, size_bytes, sidecar_id, status)
       VALUES ('drive', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(
      f.id,
      f.name,
      meta.contact_name,
      meta.phone_number,
      meta.channel,
      meta.direction,
      meta.call_time || f.createdTime.slice(0, 19),
      Number(f.size || 0),
      sidecars.get(f.name.replace(/\.[^.]+$/, "")) || null
    );
  });
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return fresh.length;
}

function audioKey(sourceId) {
  return `audio:${sourceId}`;
}

async function processPushedRow(env, row, budget) {
  if (!env.AUDIO) throw new Error("KV binding AUDIO is missing");
  const audio = await env.AUDIO.get(audioKey(row.source_id), "arrayBuffer");
  if (!audio) {
    // Keep the row (and any earlier transcript) and ask the Apps Script to send
    // the file again; it picks up ids with needs_audio=1 on its next run.
    const e = new Error("audio is no longer in temporary storage; asked the Apps Script to send it again");
    e.needsAudio = true;
    throw e;
  }
  const r = await transcribe(env, audio, row.file_name, row.duration_sec, budget);
  await saveTranscript(env, row, r);
  await env.AUDIO.delete(audioKey(row.source_id));
}

// Store a finished transcription. Replaces any earlier transcript of the call,
// keeps its id, and marks it for export so the Drive .md file is rewritten.
async function saveTranscript(env, row, r, extra = {}) {
  await env.DB.prepare(
    `UPDATE calls SET status=?, transcript=?, model=?, segments=?, partial_note=?,
       duration_sec=COALESCE(?, duration_sec), phone_number=COALESCE(?, phone_number), direction=COALESCE(?, direction),
       error=NULL, attempts=attempts+1, transcribed_at=datetime('now'), prev_status=NULL, needs_audio=0, exported=0
     WHERE id=?`
  ).bind(
    r.partialNote ? "partial" : "done",
    r.text,
    r.model,
    JSON.stringify(r.segments || []),
    r.partialNote,
    r.durationSec ? Math.round(r.durationSec) : extra.duration ?? null,
    extra.phone ?? null,
    extra.direction ?? null,
    row.id
  ).run();
  if (r.partialNote) console.log(JSON.stringify({ partial: row.id, note: r.partialNote }));
}

async function processDriveRow(env, token, row, budget) {
  // Metadata written by Cube ACR next to the recording: duration (ms), number, direction
  let duration = row.duration_sec;
  let phone = row.phone_number;
  let direction = row.direction;
  if (row.sidecar_id) {
    try {
      const res = await fetch(`${driveBase(env)}/files/${row.sidecar_id}?alt=media&supportsAllDrives=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const meta = await res.json();
        if (meta.duration) duration = Math.round(Number(meta.duration) / 1000);
        if (meta.callee && !phone) phone = String(meta.callee);
        if (meta.direction) direction = meta.direction;
      }
    } catch {
      /* metadata is optional */
    }
  }

  if (row.size_bytes > OPENAI_MAX_BYTES) {
    const e = new Error(`file is ${(row.size_bytes / 1048576).toFixed(1)}MB, over OpenAI's 25MB limit`);
    e.skip = true;
    throw e;
  }
  if (!OPENAI_EXT.test(row.file_name)) {
    const e = new Error("audio format not supported by OpenAI (switch Cube ACR to m4a/mp3)");
    e.skip = true;
    throw e;
  }

  const res = await fetch(`${driveBase(env)}/files/${row.source_id}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    const e = new Error("file no longer in Drive");
    e.skip = true;
    throw e;
  }
  if (!res.ok) throw new Error(`Drive download failed ${res.status}`);
  const audio = await res.arrayBuffer();

  const r = await transcribe(env, audio, row.file_name, duration, budget);
  await saveTranscript(env, row, r, { duration, phone, direction });
}

const BASE_PROMPT = "שיחת טלפון בעברית בין שני אנשים. ייתכנו מונחים באנגלית.";

// Transcribes a whole recording. Returns
//   { text, model, segments: [{start, end, text, status}], partialNote, durationSec }
// status per segment: "ok" | "truncated" (hit the output limit) | "failed".
// partialNote is null when every piece was transcribed in full.
// budget (optional) = { openaiCalls } is shared across one sync run.
async function transcribe(env, audio, fileName, durationSec, budget = {}) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY secret is missing");
  const ext = (fileName.match(/\.([^.]+)$/) || [, "m4a"])[1].toLowerCase();

  let mp4 = null;
  // short calls are sent whole (cheaper on CPU); if one still hits the limit,
  // the whole-file path below falls back to whisper-1
  const short = durationSec && durationSec <= SPLIT_ABOVE_SEC;
  if ((ext === "m4a" || ext === "mp4") && !short) {
    try {
      mp4 = parseMp4Audio(audio);
    } catch (err) {
      console.log(`mp4 parse failed for ${fileName}: ${err.message}; sending the file whole`);
    }
  }

  if (mp4) {
    const total = mp4.durationSec;
    const ranges = planCuts(mp4, 0, mp4.sampleCount);
    const segments = [];
    const models = new Set();
    let prevText = "";
    for (const [a, b] of ranges) {
      for (const seg of await transcribeRange(env, mp4, a, b, prevText, budget, 0)) {
        segments.push(seg);
        if (seg.model) models.add(seg.model);
        if (seg.text) prevText = seg.text;
      }
    }
    return finish(segments, [...models].join("+") || null, total);
  }

  // Not an MP4 we can cut: one request for the whole file.
  const primary = env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
  const long = durationSec && durationSec > LONG_CALL_SEC;
  const mime = { m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm", flac: "audio/flac", mpeg: "audio/mpeg", mpga: "audio/mpeg" }[ext] || "application/octet-stream";
  const blob = new Blob([audio], { type: mime });
  let r = long ? null : await transcribeBlob(env, blob, `call.${ext}`, primary, BASE_PROMPT, budget, true);
  if (!r || r.truncated) {
    // whisper-1 has no overall output limit and returns timestamps
    try {
      r = await transcribeBlob(env, blob, `call.${ext}`, "whisper-1", BASE_PROMPT, budget, false);
    } catch (err) {
      if (!r || err.halt) throw err;
      // keep the cut-off gpt-4o text; it is marked partial below
    }
  }
  const end = durationSec || r.lastEnd || null;
  const segments = r.segments?.length
    ? r.segments
    : [{ start: 0, end, text: r.text, status: r.truncated ? "truncated" : "ok", model: r.model }];
  if (r.truncated) for (const s of segments) s.status = "truncated";
  return finish(segments, r.model, durationSec || null);
}

// Transcribe samples [a, b) of a parsed MP4. If the text hits the output limit,
// cut the range in two and try again (up to two levels deep).
async function transcribeRange(env, mp4, a, b, prevText, budget, depth) {
  const start = mp4.sampleTime(a);
  const end = mp4.sampleTime(b);
  const prompt = prevText ? `${BASE_PROMPT} ${prevText.slice(-200)}` : BASE_PROMPT;
  const piece = buildM4a(mp4, a, b);
  const blob = new Blob([piece], { type: "audio/mp4" });
  let r;
  try {
    r = await transcribeBlob(env, blob, "call.m4a", env.TRANSCRIBE_MODEL || "gpt-4o-transcribe", prompt, budget, true);
  } catch (err) {
    if (err.halt) throw err;
    return [{ start, end, text: "", status: "failed", error: String(err.message).slice(0, 200) }];
  }
  if (r.truncated && depth < 2 && b - a > 2 * mp4.samplesPerSec * 30) {
    const mid = quietestSample(mp4, a + Math.floor((b - a) * 0.35), a + Math.floor((b - a) * 0.65));
    const left = await transcribeRange(env, mp4, a, mid, prevText, budget, depth + 1);
    const lastText = left.filter((s) => s.text).pop()?.text || prevText;
    const right = await transcribeRange(env, mp4, mid, b, lastText, budget, depth + 1);
    return [...left, ...right];
  }
  return [{ start, end, text: r.text, status: r.truncated ? "truncated" : "ok", model: r.model, tokens: r.outputTokens }];
}

function finish(segments, model, totalSec) {
  for (const s of segments) {
    s.start = s.start == null ? null : Math.round(s.start * 10) / 10;
    s.end = s.end == null ? null : Math.round(s.end * 10) / 10;
  }
  const text = segments.map((s) => s.text).filter(Boolean).join("\n\n").trim();
  const bad = segments.filter((s) => s.status !== "ok");
  let partialNote = null;
  if (bad.length) {
    const parts = bad.map((s) => {
      const range = s.start != null && s.end != null ? `${fmtDuration(Math.round(s.start))}–${fmtDuration(Math.round(s.end))}` : "part of the call";
      return s.status === "failed" ? `${range} could not be transcribed` : `${range} is cut off before its end`;
    });
    partialNote = `Transcript is incomplete${totalSec ? ` (call length ${fmtDuration(Math.round(totalSec))})` : ""}: ${parts.join("; ")}.`;
  }
  if (!text && !bad.length) return { text: "(empty: no speech detected)", model, segments, partialNote, durationSec: totalSec };
  if (!text) {
    const e = new Error(bad.map((s) => s.error).filter(Boolean)[0] || "no piece of the recording could be transcribed");
    throw e;
  }
  // keep segment JSON small: drop per-piece model when it's the only one
  for (const s of segments) if (s.model === model) delete s.model;
  return { text, model, segments, partialNote, durationSec: totalSec };
}

// One request to /audio/transcriptions. With fallback=true a non-account error
// on gpt-4o models is retried once with whisper-1.
async function transcribeBlob(env, blob, name, model, prompt, budget, fallback) {
  const base = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const models = fallback && model !== "whisper-1" ? [model, "whisper-1"] : [model];
  let lastErr;
  for (const m of models) {
    if (budget) budget.openaiCalls = (budget.openaiCalls || 0) + 1;
    const form = new FormData();
    form.append("file", blob, name);
    form.append("model", m);
    const whisper = m === "whisper-1";
    form.append("response_format", whisper ? "verbose_json" : "json");
    if (whisper) form.append("timestamp_granularities[]", "segment");
    if (env.TRANSCRIBE_LANGUAGE) form.append("language", env.TRANSCRIBE_LANGUAGE);
    form.append("prompt", prompt);
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.text || "").trim();
      const outputTokens = data.usage?.output_tokens ?? null;
      // gpt-4o models return the text written so far when they hit the limit
      const truncated = !whisper && (outputTokens != null ? outputTokens >= NEAR_CAP_TOKENS : text.length >= NEAR_CAP_CHARS);
      console.log(JSON.stringify({ transcribe: m, bytes: blob.size, chars: text.length, output_tokens: outputTokens, truncated }));
      const out = { text, model: m, truncated, outputTokens };
      if (whisper && Array.isArray(data.segments) && data.segments.length) {
        out.segments = groupWhisperSegments(data.segments, m);
        out.lastEnd = data.segments[data.segments.length - 1].end;
      }
      return out;
    }
    const detail = (await res.text()).slice(0, 300);
    lastErr = new Error(`OpenAI ${m} ${res.status}: ${detail}`);
    // account problems won't be fixed by another model or another file
    if (res.status === 401 || res.status === 402 || res.status === 429 || res.status === 403) {
      lastErr.halt = true;
      if (res.status === 401) lastErr.alert = "The OpenAI API key is invalid or was revoked.";
      else if (res.status === 402 || /insufficient_quota|billing|quota|credit/i.test(detail)) lastErr.alert = "OpenAI is out of credit (insufficient_quota): add credit to the OpenAI account.";
      else if (res.status === 403) lastErr.alert = `OpenAI refused the request (403): ${detail.slice(0, 120)}`;
      break;
    }
  }
  throw lastErr;
}

// whisper-1 returns many short segments; merge them into ~1-minute paragraphs
function groupWhisperSegments(segs, model) {
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (!cur || s.end - cur.start > 60) {
      cur = { start: s.start, end: s.end, text: "", status: "ok", model };
      out.push(cur);
    }
    cur.end = s.end;
    cur.text = (cur.text + " " + String(s.text || "").trim()).trim();
  }
  return out;
}

// Number of OpenAI requests a recording will need (for the per-run budget)
function estimateRequests(durationSec) {
  if (!durationSec || durationSec <= SPLIT_ABOVE_SEC) return 1;
  return Math.ceil(durationSec / CHUNK_MAX_SEC) + 1;
}

// ---------------------------------------------------------------------------
// MP4/M4A cutting, without decoding. Cube ACR writes AAC in an M4A container.
// We read the sample tables of the audio track, then write each piece as a new
// small M4A that holds a whole number of AAC frames, so nothing is re-encoded.
// ---------------------------------------------------------------------------

function readBoxes(view, start, end) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(view.getUint8(pos + 4), view.getUint8(pos + 5), view.getUint8(pos + 6), view.getUint8(pos + 7));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) throw new Error(`bad box ${type} at ${pos}`);
    boxes.push({ type, start: pos, end: pos + size, body: pos + header });
    pos += size;
  }
  return boxes;
}

function child(view, box, type) {
  return readBoxes(view, box.body, box.end).find((b) => b.type === type) || null;
}

function parseMp4Audio(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const top = readBoxes(view, 0, bytes.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov box");
  if (child(view, moov, "mvex")) throw new Error("fragmented MP4 is not supported");
  const traks = readBoxes(view, moov.body, moov.end).filter((b) => b.type === "trak");
  for (const trak of traks) {
    const mdia = child(view, trak, "mdia");
    const hdlr = mdia && child(view, mdia, "hdlr");
    if (!hdlr) continue;
    const handler = String.fromCharCode(...bytes.subarray(hdlr.body + 8, hdlr.body + 12));
    if (handler !== "soun") continue;
    const mdhd = child(view, mdia, "mdhd");
    const v = view.getUint8(mdhd.body);
    const timescale = view.getUint32(mdhd.body + (v === 1 ? 20 : 12));
    const language = view.getUint16(mdhd.body + (v === 1 ? 32 : 20));
    const stbl = child(view, child(view, mdia, "minf"), "stbl");
    const stsd = child(view, stbl, "stsd");
    const stts = child(view, stbl, "stts");
    const stsz = child(view, stbl, "stsz");
    const stsc = child(view, stbl, "stsc");
    const stco = child(view, stbl, "stco") || child(view, stbl, "co64");
    if (!stsd || !stts || !stsz || !stsc || !stco) throw new Error("missing sample tables");

    // sizes
    const fixed = view.getUint32(stsz.body + 4);
    const count = view.getUint32(stsz.body + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || view.getUint32(stsz.body + 12 + i * 4);

    // start time of every sample, plus one past the end
    const times = new Float64Array(count + 1);
    {
      const n = view.getUint32(stts.body + 4);
      let i = 0;
      let t = 0;
      for (let e = 0; e < n; e++) {
        const c = view.getUint32(stts.body + 8 + e * 8);
        const d = view.getUint32(stts.body + 12 + e * 8);
        for (let k = 0; k < c && i < count; k++) {
          times[i++] = t;
          t += d;
        }
      }
      if (i !== count) throw new Error("stts does not cover all samples");
      times[count] = t;
    }

    // byte offset of every sample
    const offsets = new Float64Array(count);
    {
      const is64 = stco.type === "co64";
      const nChunks = view.getUint32(stco.body + 4);
      const chunkOffset = (c) => (is64 ? Number(view.getBigUint64(stco.body + 8 + c * 8)) : view.getUint32(stco.body + 8 + c * 4));
      const nEntries = view.getUint32(stsc.body + 4);
      let s = 0;
      for (let e = 0; e < nEntries; e++) {
        const first = view.getUint32(stsc.body + 8 + e * 12) - 1;
        const per = view.getUint32(stsc.body + 12 + e * 12);
        const next = e + 1 < nEntries ? view.getUint32(stsc.body + 8 + (e + 1) * 12) - 1 : nChunks;
        for (let c = first; c < next && s < count; c++) {
          let off = chunkOffset(c);
          for (let k = 0; k < per && s < count; k++) {
            offsets[s] = off;
            off += sizes[s++];
          }
        }
      }
      if (s !== count) throw new Error("stsc does not cover all samples");
      for (let i = 0; i < count; i++) if (offsets[i] + sizes[i] > bytes.length) throw new Error("sample outside the file");
    }

    const durationSec = times[count] / timescale;
    return {
      bytes,
      timescale,
      language,
      stsd: bytes.slice(stsd.start, stsd.end),
      sizes,
      times,
      offsets,
      sampleCount: count,
      durationSec,
      samplesPerSec: count / Math.max(durationSec, 0.001),
      sampleTime(i) {
        return times[i] / timescale;
      },
    };
  }
  throw new Error("no audio track");
}

// Sample index in [from, to) with the least audio data around it (AAC spends
// fewer bytes on silence), so cuts fall between words.
function quietestSample(mp4, from, to) {
  const w = Math.max(1, Math.round(mp4.samplesPerSec * 0.4));
  from = Math.max(from, w);
  to = Math.min(to, mp4.sampleCount - w);
  if (to <= from) return Math.max(1, Math.min(mp4.sampleCount - 1, from));
  let sum = 0;
  for (let i = from - w; i < from + w; i++) sum += mp4.sizes[i];
  let best = from;
  let bestSum = sum;
  for (let i = from + 1; i < to; i++) {
    sum += mp4.sizes[i + w - 1] - mp4.sizes[i - w - 1];
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  return best;
}

// Cut points: whole range if short, else pieces of CHUNK_MIN_SEC..CHUNK_MAX_SEC
function planCuts(mp4, a, b) {
  const t = (i) => mp4.sampleTime(i);
  if (t(b) - t(a) <= SPLIT_ABOVE_SEC) return [[a, b]];
  const ranges = [];
  let s = a;
  while (t(b) - t(s) > CHUNK_MAX_SEC) {
    const lo = sampleAt(mp4, t(s) + CHUNK_MIN_SEC);
    const hi = sampleAt(mp4, t(s) + CHUNK_MAX_SEC);
    const cut = quietestSample(mp4, lo, hi);
    ranges.push([s, cut]);
    s = cut;
  }
  // don't leave a tiny last piece: if under a minute, merge into the previous one
  if (ranges.length && t(b) - t(s) < 60) ranges[ranges.length - 1][1] = b;
  else ranges.push([s, b]);
  return ranges;
}

function sampleAt(mp4, sec) {
  const target = sec * mp4.timescale;
  let lo = 0;
  let hi = mp4.sampleCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mp4.times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildM4a(mp4, a, b) {
  const n = b - a;
  const duration = mp4.times[b] - mp4.times[a];
  let dataSize = 0;
  for (let i = a; i < b; i++) dataSize += mp4.sizes[i];

  // stts as runs of equal durations
  const runs = [];
  for (let i = a; i < b; i++) {
    const d = mp4.times[i + 1] - mp4.times[i];
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }

  // Box tree as nested [type, ...fields]; a field is a Uint8Array or an
  // array of [bytes, value] pairs written big-endian. Sizes are computed first,
  // then everything is written once into a single buffer.
  const F = (bytes, v) => [bytes, v];
  const str4 = (t) => F(4, (t.charCodeAt(0) << 24 | t.charCodeAt(1) << 16 | t.charCodeAt(2) << 8 | t.charCodeAt(3)) >>> 0);
  const zeros = (k) => new Uint8Array(k);
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map((x) => F(4, x));
  const fullHdr = (version, flags) => F(4, ((version << 24) | flags) >>> 0);
  const name = new TextEncoder().encode("SoundHandler\0");

  const stszTable = new Uint8Array(n * 4);
  {
    const dv = new DataView(stszTable.buffer);
    for (let i = 0; i < n; i++) dv.setUint32(i * 4, mp4.sizes[a + i]);
  }
  const sttsTable = new Uint8Array(runs.length * 8);
  {
    const dv = new DataView(sttsTable.buffer);
    runs.forEach(([c, d], i) => {
      dv.setUint32(i * 8, c);
      dv.setUint32(i * 8 + 4, d);
    });
  }
  const stcoEntry = [0]; // filled in once the moov size is known

  const tree = [
    ["ftyp", [str4("M4A "), F(4, 0), str4("M4A "), str4("mp42"), str4("isom")]],
    ["moov", [], [
      ["mvhd", [fullHdr(0, 0), F(4, 0), F(4, 0), F(4, mp4.timescale), F(4, duration), F(4, 0x10000), F(2, 0x100), F(2, 0), F(4, 0), F(4, 0), ...matrix, zeros(24), F(4, 2)]],
      ["trak", [], [
        ["tkhd", [fullHdr(0, 3), F(4, 0), F(4, 0), F(4, 1), F(4, 0), F(4, duration), F(4, 0), F(4, 0), F(2, 0), F(2, 0), F(2, 0x100), F(2, 0), ...matrix, F(4, 0), F(4, 0)]],
        ["mdia", [], [
          ["mdhd", [fullHdr(0, 0), F(4, 0), F(4, 0), F(4, mp4.timescale), F(4, duration), F(2, mp4.language), F(2, 0)]],
          ["hdlr", [fullHdr(0, 0), F(4, 0), str4("soun"), zeros(12), name]],
          ["minf", [], [
            ["smhd", [fullHdr(0, 0), F(2, 0), F(2, 0)]],
            ["dinf", [], [["dref", [fullHdr(0, 0), F(4, 1)], [["url ", [fullHdr(0, 1)]]]]]],
            ["stbl", [], [
              [null, [mp4.stsd]], // copied as is: codec and decoder config
              ["stts", [fullHdr(0, 0), F(4, runs.length), sttsTable]],
              ["stsc", [fullHdr(0, 0), F(4, 1), F(4, 1), F(4, n), F(4, 1)]],
              ["stsz", [fullHdr(0, 0), F(4, 0), F(4, n), stszTable]],
              ["stco", [fullHdr(0, 0), F(4, 1), stcoEntry]],
            ]],
          ]],
        ]],
      ]],
    ]],
  ];

  const fieldLen = (f) => (f instanceof Uint8Array ? f.length : f === stcoEntry ? 4 : f[0]);
  const boxLen = ([type, fields, kids = []]) =>
    (type ? 8 : 0) + fields.reduce((s, f) => s + fieldLen(f), 0) + kids.reduce((s, k) => s + boxLen(k), 0);
  const headLen = tree.reduce((s, k) => s + boxLen(k), 0);
  const mdatOffset = headLen + 8;
  stcoEntry[0] = mdatOffset;

  const out = new Uint8Array(mdatOffset + dataSize);
  const dv = new DataView(out.buffer);
  let pos = 0;
  const put = (bytes, v) => {
    if (bytes === 4) dv.setUint32(pos, v);
    else dv.setUint16(pos, v);
    pos += bytes;
  };
  const write = (box) => {
    const [type, fields, kids = []] = box;
    if (type) {
      put(4, boxLen(box));
      put(...str4(type));
    }
    for (const f of fields) {
      if (f instanceof Uint8Array) {
        out.set(f, pos);
        pos += f.length;
      } else if (f === stcoEntry) put(4, f[0]);
      else put(f[0], f[1]);
    }
    for (const k of kids) write(k);
  };
  for (const box of tree) write(box);
  put(4, dataSize + 8);
  put(...str4("mdat"));
  // copy runs of samples that sit next to each other in the file in one go
  for (let i = a; i < b; ) {
    const off = mp4.offsets[i];
    let len = mp4.sizes[i++];
    while (i < b && mp4.offsets[i] === off + len) len += mp4.sizes[i++];
    out.set(mp4.bytes.subarray(off, off + len), pos);
    pos += len;
  }
  return out;
}

// Cube ACR names: "Name (0500000000) ↙ (phone) 2026-11-15 21-17-51.m4a"
//                 "Name (whatsapp) 2026-11-15 21-22-37.m4a"
//                 or date-first when "Record's title starts with a date" is on.
function parseCubeFileName(name) {
  const base = name.replace(/\.[^.]+$/, "");
  const out = { contact_name: null, phone_number: null, channel: null, direction: null, call_time: null };
  const dm = base.match(/(\d{4}-\d{2}-\d{2})[ _](\d{2})-(\d{2})-(\d{2})/);
  if (dm) out.call_time = `${dm[1]}T${dm[2]}:${dm[3]}:${dm[4]}`;
  let rest = dm ? base.replace(dm[0], " ") : base;

  if (/↙|↘/.test(rest)) out.direction = "Incoming";
  else if (/↗|↖/.test(rest)) out.direction = "Outgoing";
  rest = rest.replace(/[↙↘↗↖]/g, " ");

  const groups = [...rest.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim());
  for (const g of groups) {
    if (/^\+?[\d\s\-*#]{3,}$/.test(g)) out.phone_number = g.replace(/[\s-]/g, "");
    else if (/^[a-z_ ]+$/i.test(g)) out.channel = g.toLowerCase();
  }
  const contact = rest.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  out.contact_name = contact || out.phone_number;
  return out;
}

// ---------------------------------------------------------------------------
// Push ingest (used by the Google Apps Script in apps-script/Code.gs)
//   POST /ingest/<token>/check   {"ids": [...]}  -> {"unknown": [...]}
//   POST /ingest/<token>?id=&name=&duration_ms=&callee=&direction=&size=   body = audio bytes
// The audio waits in KV until the cron job transcribes it, then is deleted.
// ---------------------------------------------------------------------------

// OpenAI account alert (no credit / bad key), stored in the meta table
async function getAlert(env) {
  const r = await env.DB.prepare("SELECT value, updated_at FROM meta WHERE key='openai_alert'").first();
  return r ? { message: r.value, since: r.updated_at } : null;
}
async function setAlert(env, message) {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('openai_alert', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value != excluded.value"
  ).bind(message).run();
}
async function clearAlert(env) {
  await env.DB.prepare("DELETE FROM meta WHERE key='openai_alert'").run();
}

// Used by the Apps Script to email you when OpenAI needs attention
async function handleHealth(env) {
  const alert = await getAlert(env);
  const p = await env.DB.prepare("SELECT COUNT(*) n FROM calls WHERE status IN ('pending','processing')").first();
  return json({ alert, pending: p?.n || 0, billing_url: BILLING_URL });
}

// Finished transcripts not yet saved to Drive by the Apps Script
async function handleDone(env, url) {
  const limit = clamp(url.searchParams.get("limit") ?? 20, 1, 50);
  const { results } = await env.DB.prepare(
    `SELECT id, source_id, file_name, contact_name, phone_number, channel, direction, call_time, duration_sec, model, transcript, segments, partial_note, status
     FROM calls WHERE status IN ('done','partial') AND exported=0 ORDER BY id LIMIT ?`
  ).bind(limit).all();
  for (const r of results) r.transcript_marked = renderTranscript(r);
  return json({ calls: results });
}

async function handleAck(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const { ids } = await request.json();
  if (!Array.isArray(ids)) return json({ error: "ids must be an array" }, 400);
  await env.DB.prepare("UPDATE calls SET exported=1 WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids.map(Number))).run();
  return json({ ok: true });
}

async function handleIngestCheck(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const { ids } = await request.json();
  if (!Array.isArray(ids)) return json({ error: "ids must be an array" }, 400);
  const known = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const { results } = await env.DB.prepare(
      "SELECT source_id FROM calls WHERE source_id IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify(ids.slice(i, i + 500).map(String))).all();
    for (const r of results) known.add(r.source_id);
  }
  // recordings the Worker needs again (retry, or audio expired from KV)
  const { results: again } = await env.DB.prepare(
    "SELECT source_id FROM calls WHERE needs_audio=1 AND source='push' ORDER BY id DESC LIMIT 10"
  ).all();
  return json({ unknown: ids.filter((id) => !known.has(String(id))), resend: again.map((r) => r.source_id) });
}

// The Apps Script reports recordings it could not find in Drive any more
async function handleGone(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const { ids } = await request.json();
  if (!Array.isArray(ids)) return json({ error: "ids must be an array" }, 400);
  await env.DB.prepare(
    `UPDATE calls SET needs_audio=0, error='recording is no longer in Google Drive',
       status=CASE WHEN transcript IS NOT NULL THEN COALESCE(prev_status, status) ELSE 'skipped' END, prev_status=NULL
     WHERE needs_audio=1 AND source_id IN (SELECT value FROM json_each(?))`
  ).bind(JSON.stringify(ids.map(String))).run();
  return json({ ok: true });
}

async function handleIngest(request, env, url) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  if (!env.AUDIO) return json({ error: "KV binding AUDIO is missing" }, 500);
  const q = url.searchParams;
  const id = q.get("id");
  const name = q.get("name");
  if (!id || !name) return json({ error: "id and name are required" }, 400);

  const exists = await env.DB.prepare("SELECT id, needs_audio FROM calls WHERE source_id = ?").bind(id).first();
  if (exists && !exists.needs_audio) return json({ status: "exists", id: exists.id });
  if (exists) {
    // the audio of a known call, sent again for a re-transcription: same id
    const audio = await request.arrayBuffer();
    if (!audio.byteLength) return json({ error: "empty body" }, 400);
    if (audio.byteLength > OPENAI_MAX_BYTES) return json({ error: "file over 25MB" }, 413);
    await env.AUDIO.put(audioKey(id), audio, { expirationTtl: 7 * 86400 });
    await env.DB.prepare(
      `UPDATE calls SET needs_audio=0, status='pending', attempts=0, error=NULL,
         prev_status=CASE WHEN status IN ('done','partial') THEN status ELSE prev_status END
       WHERE id=?`
    ).bind(exists.id).run();
    return json({ status: "requeued", id: exists.id });
  }

  const size = Number(q.get("size") || 0);
  const audio = await request.arrayBuffer();
  const meta = parseCubeFileName(name);
  const durationMs = Number(q.get("duration_ms") || 0);
  let status = "pending";
  let error = null;
  if (size > OPENAI_MAX_BYTES || audio.byteLength > OPENAI_MAX_BYTES) {
    status = "skipped";
    error = `file is ${((size || audio.byteLength) / 1048576).toFixed(1)}MB, over OpenAI's 25MB limit`;
  } else if (!OPENAI_EXT.test(name)) {
    status = "skipped";
    error = "audio format not supported by OpenAI (switch Cube ACR to m4a/mp3)";
  } else if (!audio.byteLength) {
    return json({ error: "empty body" }, 400);
  }

  if (status === "pending") {
    // keep for at most 7 days; normally deleted minutes later after transcription
    await env.AUDIO.put(audioKey(id), audio, { expirationTtl: 7 * 86400 });
  }
  const row = await env.DB.prepare(
    `INSERT OR IGNORE INTO calls (source, source_id, file_name, contact_name, phone_number, channel, direction, call_time, duration_sec, size_bytes, status, error)
     VALUES ('push', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    id,
    name,
    meta.contact_name,
    q.get("callee") || meta.phone_number,
    meta.channel,
    q.get("direction") || meta.direction,
    meta.call_time || (q.get("created") || new Date().toISOString()).slice(0, 19),
    durationMs ? Math.round(durationMs / 1000) : null,
    size || audio.byteLength,
    status,
    error
  ).first();
  return json({ status: row ? (status === "pending" ? "queued" : status) : "exists", id: row?.id });
}

// ---------------------------------------------------------------------------
// Manual upload: POST /upload/<token>  (multipart field "file", or raw body + ?name=)
// Transcribes immediately and stores it. Useful for testing or other sources.
// ---------------------------------------------------------------------------

async function handleUpload(request, env, url) {
  if (request.method !== "POST") return new Response("POST an audio file", { status: 405 });
  let audio, fileName;
  const ct = request.headers.get("content-type") || "";
  if (ct.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return json({ error: "multipart field 'file' is required" }, 400);
    audio = await file.arrayBuffer();
    fileName = file.name || "upload.m4a";
  } else {
    audio = await request.arrayBuffer();
    fileName = url.searchParams.get("name") || "upload.m4a";
  }
  if (!audio.byteLength) return json({ error: "empty body" }, 400);
  if (audio.byteLength > OPENAI_MAX_BYTES) return json({ error: "file over 25MB" }, 413);

  const meta = parseCubeFileName(fileName);
  const duration = url.searchParams.get("duration_sec") ? Number(url.searchParams.get("duration_sec")) : null;
  const r = await transcribe(env, audio, fileName, duration);
  const { text, model } = r;
  const sourceId = `upload:${crypto.randomUUID()}`;
  const row = await env.DB.prepare(
    `INSERT INTO calls (source, source_id, file_name, contact_name, phone_number, channel, direction, call_time, duration_sec, size_bytes, status, model, transcript, segments, partial_note, transcribed_at, attempts)
     VALUES ('upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1) RETURNING id`
  ).bind(
    sourceId,
    fileName,
    meta.contact_name,
    meta.phone_number,
    meta.channel,
    meta.direction,
    meta.call_time || new Date().toISOString().slice(0, 19),
    r.durationSec ? Math.round(r.durationSec) : duration,
    audio.byteLength,
    r.partialNote ? "partial" : "done",
    model,
    text,
    JSON.stringify(r.segments || []),
    r.partialNote
  ).first();
  return json({ id: row.id, model, chars: text.length, partial: r.partialNote });
}

// ---------------------------------------------------------------------------
// Google service-account auth (JWT -> access token), cached per isolate
// ---------------------------------------------------------------------------

let cachedToken = null;

// Overridable only for local testing
function driveBase(env) {
  return env.DRIVE_API_BASE || "https://www.googleapis.com/drive/v3";
}

async function googleAccessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch(env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google auth failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
