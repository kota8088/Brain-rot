// =============================================================================
//  パイロット視点レーシングゲーム
// =============================================================================
//  このファイルはゲーム全体を動かすJavaScriptです。
//
//  ▼ファイルの読み方
//   1. CONFIG（設定値）……速さや道路の幅などをまとめてあります。
//      ここの数字を変えるとゲームの感じが変わります。
//   2. DOM要素 …………… HTMLの要素を取ってきます。
//   3. ゲームの状態 ……… プレイヤーの位置・速度・ラップ数など。
//   4. コース作り ……… 道のセグメントを順番に並べてコースを作ります。
//   5. キー入力 ………… 矢印キーなどの状態を保持します。
//   6. オーディオ ……… エンジン音とBGMをWeb Audio APIで合成します。
//   7. 更新処理（update）……… 1フレームごとに動きを計算します。
//   8. 描画処理（render）……… 道路・他車・自分の車を画面に描きます。
//   9. HUD（画面の数字）…… 速度・ラップ・タイムを更新します。
//  10. ゲームループ …… update→renderを繰り返します。
//  11. 開始／ゴール …… STARTやリスタートの処理。
//  12. 起動 …………… ボタンにイベントを付けてゲームを始めます。
//
//  ▼疑似3Dの仕組み
//   この道路は本物の3Dではありません。
//   コースを「セグメント」と呼ぶ短い区間に分割し、
//   それぞれをカメラから見た位置に変換して台形で描くと、
//   遠くは細く・近くは太く見えて立体感が出ます（Out Run方式）。
// =============================================================================

(() => {
  "use strict";

  // ===========================================================================
  //  1. CONFIG —— 設定値（ここを変えると遊び心地が変わります）
  // ===========================================================================

  // --- 道路の見た目 ---
  const SEGMENT_LENGTH = 200; // 1セグメントの奥行き
  const ROAD_WIDTH = 2000; // 道路の半分の幅（中心から左右に伸びる長さ）
  const LANES = 3; // 車線の数
  const RUMBLE_LENGTH = 3; // 縁石が色を変えるセグメント数

  // --- カメラ（視点）---
  const DRAW_DISTANCE = 300; // 何セグメント先まで描くか（大きいほど遠くまで見える）
  const CAMERA_HEIGHT = 1000; // カメラ（運転手の目）の高さ
  const FIELD_OF_VIEW = 100; // 視野角の度数（大きいほど広角）
  const CAMERA_DEPTH = 1 / Math.tan(((FIELD_OF_VIEW / 2) * Math.PI) / 180);

  // --- 速度・物理（数値はすべて「1秒あたりに進む距離」が基準）---
  const MAX_SPEED = SEGMENT_LENGTH * 60; // 最高速度
  const ACCEL = MAX_SPEED / 5; // アクセルを踏んだときの加速
  const DECEL = -MAX_SPEED / 6; // 何もしないときの自然減速
  const BRAKING = -MAX_SPEED; // ブレーキの減速
  const TURBO_BOOST = 1.35; // Shiftターボ時の加速倍率
  const OFFROAD_DECEL = -MAX_SPEED / 2; // コース外を走ったときの減速
  const OFFROAD_LIMIT = MAX_SPEED / 4; // コース外で出せる最大速度
  const CENTRIFUGAL = 0.3; // カーブで外側に膨らむ強さ

  // --- ゲームルール ---
  const TOTAL_LAPS = 3; // ゴールまでの周回数

  // --- 衝突判定の幅（小さいほどぶつかりにくい）---
  const CAR_HIT_WIDTH = 0.35; // 他車との衝突幅
  const TREE_HIT_WIDTH = 0.4; // 木との衝突幅

  // --- 色設定 ---
  // LIGHT と DARK を交互に並べることで縞模様の道路になります。
  // START はスタートライン、FINISH はゴールライン用の色です。
  const COLORS = {
    TREE: "#0a5d2a",
    LIGHT: {
      road: "#6b6b6b",
      grass: "#10a020",
      rumble: "#ffffff",
      lane: "#ffffff",
    },
    DARK: {
      road: "#606060",
      grass: "#0e9018",
      rumble: "#c83030",
      lane: "transparent",
    },
    START: {
      road: "#ffffff",
      grass: "#10a020",
      rumble: "#ffffff",
      lane: "#ffffff",
    },
    FINISH: {
      road: "#000000",
      grass: "#10a020",
      rumble: "#000000",
      lane: "#000000",
    },
  };

  // ===========================================================================
  //  2. DOM要素（HTMLの部品）を取得
  // ===========================================================================
  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  const speedEl = document.getElementById("speedValue");
  const lapEl = document.getElementById("lapValue");
  const timeEl = document.getElementById("timeValue");
  const bestEl = document.getElementById("bestValue");
  const rpmFill = document.getElementById("rpmFill");
  const gearEl = document.getElementById("gearValue");

  const startScreen = document.getElementById("startScreen");
  const finishScreen = document.getElementById("finishScreen");
  const startBtn = document.getElementById("startBtn");
  const restartBtn = document.getElementById("restartBtn");
  const finalTime = document.getElementById("finalTime");
  const finalBest = document.getElementById("finalBest");

  // ===========================================================================
  //  3. ゲームの状態（毎フレーム変わる値）
  // ===========================================================================
  // プレイヤーの位置と速度
  const player = {
    x: 0, // 横位置（-1〜+1が道路の中、それ以上はコース外）
    z: 0, // コース上の進行距離
    speed: 0, // 現在の速度
  };

  // ゲーム全体の状態
  const state = {
    running: false, // 走行中かどうか
    finished: false, // ゴール済みかどうか
    elapsed: 0, // 経過時間（秒）
    lap: 1, // 現在のラップ
    bestTime: null, // ベストタイム
    courseLength: 0, // 1周の距離
  };

  // ===========================================================================
  //  4. コースの作成
  // ===========================================================================
  const segments = [];

  // 直前のセグメントの終わりの高さを取得
  function lastY() {
    return segments.length === 0 ? 0 : segments[segments.length - 1].p2.world.y;
  }

  // セグメントを1つ追加する
  //   curve: カーブの強さ（マイナス=左、プラス=右、0=直線）
  //   y:     セグメントの終わりの高さ
  function addSegment(curve, y) {
    const n = segments.length;
    segments.push({
      index: n,
      p1: {
        world: { y: lastY(), z: n * SEGMENT_LENGTH },
        camera: {},
        screen: {},
      },
      p2: {
        world: { y: y, z: (n + 1) * SEGMENT_LENGTH },
        camera: {},
        screen: {},
      },
      curve,
      sprites: [], // この区間に置く木など
      cars: [], // この区間にいる他車
      color: Math.floor(n / RUMBLE_LENGTH) % 2 ? COLORS.DARK : COLORS.LIGHT,
    });
  }

  // 補間用ヘルパ（カーブや坂をなめらかに変化させる）
  function easeIn(a, b, percent) {
    return a + (b - a) * Math.pow(percent, 2);
  }
  function easeInOut(a, b, percent) {
    return a + (b - a) * (-Math.cos(percent * Math.PI) / 2 + 0.5);
  }

  // 「だんだん入って→保持→だんだん抜ける」3段階で1区間を作る
  function addRoad(enter, hold, leave, curve, y) {
    const startY = lastY();
    const endY = startY + y * SEGMENT_LENGTH;
    const total = enter + hold + leave;
    for (let i = 0; i < enter; i++)
      addSegment(
        easeIn(0, curve, i / enter),
        easeInOut(startY, endY, i / total),
      );
    for (let i = 0; i < hold; i++)
      addSegment(curve, easeInOut(startY, endY, (enter + i) / total));
    for (let i = 0; i < leave; i++)
      addSegment(
        easeInOut(curve, 0, i / leave),
        easeInOut(startY, endY, (enter + hold + i) / total),
      );
  }

  // よく使う形のショートカット
  function addStraight(num = 50) {
    addRoad(num, num, num, 0, 0);
  }
  function addCurve(num = 50, curve = 2, y = 0) {
    addRoad(num, num, num, curve, y);
  }
  function addHill(num = 50, height = 30) {
    addRoad(num, num, num, 0, height);
  }
  function addLowRollingHills(num = 100, height = 20) {
    addRoad(num, num, num, 0, height / 2);
    addRoad(num, num, num, 0, -height);
    addRoad(num, num, num, 0, height);
    addRoad(num, num, num, 0, 0);
    addRoad(num, num, num, 0, height / 2);
    addRoad(num, num, num, 0, 0);
  }
  function addSCurves() {
    addRoad(30, 30, 30, -2, 0);
    addRoad(30, 30, 30, 3, 25);
    addRoad(30, 30, 30, 4, 0);
    addRoad(30, 30, 30, -3, -25);
    addRoad(30, 30, 30, -2, 0);
  }

  // コースに木と茂みをばらまく
  function placeTrees() {
    for (
      let n = 10;
      n < segments.length;
      n += 4 + Math.floor(Math.random() * 6)
    ) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const offset = side * (1.2 + Math.random() * 2.4); // 道路の外側にずらす
      const type = Math.random() < 0.5 ? "tree" : "bush";
      segments[n].sprites.push({ offset, type });
    }
  }

  // コースに対向車（先行車）を置く
  function placeOpponentCars() {
    for (
      let n = 30;
      n < segments.length - 30;
      n += 90 + Math.floor(Math.random() * 120)
    ) {
      const lane = Math.floor(Math.random() * LANES) - 1; // -1, 0, 1
      const offset = lane * 0.6;
      const speed = MAX_SPEED / 4 + Math.random() * (MAX_SPEED / 3);
      const color = `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`;
      segments[n].cars.push({ offset, z: 0, speed, color });
    }
  }

  // コース全体を組み立てる
  function buildCourse() {
    segments.length = 0;
    addStraight(40);
    addLowRollingHills();
    addSCurves();
    addCurve(50, 3, 0);
    addStraight(30);
    addHill(40, 50);
    addCurve(60, -3, 0);
    addSCurves();
    addCurve(60, 2, 30);
    addStraight(40);
    addLowRollingHills();
    addStraight(30);

    // スタート/フィニッシュラインの色を上書き
    for (let n = 0; n < RUMBLE_LENGTH; n++) segments[n].color = COLORS.START;
    for (let n = 0; n < RUMBLE_LENGTH; n++)
      segments[segments.length - 1 - n].color = COLORS.FINISH;

    placeTrees();
    placeOpponentCars();
  }

  // 距離zから「そこにいるセグメント」を求める
  function findSegment(z) {
    return segments[Math.floor(z / SEGMENT_LENGTH) % segments.length];
  }

  // ===========================================================================
  //  5. キー入力
  // ===========================================================================
  const keys = {
    up: false,
    down: false,
    left: false,
    right: false,
    turbo: false,
  };

  function onKey(e, down) {
    const k = e.key.toLowerCase();
    if (k === "arrowup" || k === "w") keys.up = down;
    else if (k === "arrowdown" || k === "s") keys.down = down;
    else if (k === "arrowleft" || k === "a") keys.left = down;
    else if (k === "arrowright" || k === "d") keys.right = down;
    else if (k === "shift") keys.turbo = down;
    else if (k === "m") {
      if (down) setMuted(!audio.muted);
    } else return;
    e.preventDefault();
  }
  window.addEventListener("keydown", (e) => onKey(e, true));
  window.addEventListener("keyup", (e) => onKey(e, false));

  // ===========================================================================
  //  6. オーディオ（エンジン音 + BGM をWeb Audio APIで合成）
  // ===========================================================================
  //  Web Audio API は「オシレーター（音の発振器）」と「ゲイン（音量）」を
  //  つないで音を作るしくみです。スピーカーへ流すには destination につなぎます。
  //
  //  音の流れ：
  //   各音 → gain（個別音量） → bgm.gain / engine.gain → master → destination
  //
  //  ※AudioContext はユーザーがボタンを押すなど操作してからでないと
  //  鳴らせないので、STARTボタンが押されてから initAudio() を呼びます。
  // ---------------------------------------------------------------------------
  const audio = {
    ctx: null,
    enabled: false,
    muted: false,
    master: null,
    engine: { osc1: null, osc2: null, gain: null },
    bgm: { gain: null, time: 0, step: 0, timerId: null },
  };

  // ▼BGMの楽譜（MIDIノート番号）。null は休符。
  const BPM = 130;
  const BEAT = 60 / BPM; // 1拍の長さ（秒）
  const STEP = BEAT / 2; // 八分音符の長さ
  // メロディ（Eマイナーの疾走系）
  const PATTERN_MEL = [
    64,
    null,
    67,
    null,
    71,
    null,
    74,
    71,
    72,
    null,
    71,
    null,
    67,
    null,
    64,
    null,
    62,
    null,
    65,
    null,
    69,
    null,
    72,
    69,
    71,
    69,
    67,
    65,
    64,
    null,
    67,
    null,
  ];
  // ベース（低音）
  const PATTERN_BASS = [40, 40, 47, 43, 36, 36, 38, 38];
  // アルペジオ（高音のキラキラ）
  const PATTERN_ARP = [64, 67, 71, 74, 71, 67, 64, 67];

  // MIDIノート番号(60=ド)→周波数(Hz)
  function midiToFreq(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  // STARTボタンを押した時に初めてAudioContextを作る
  function initAudio() {
    if (audio.ctx) {
      // 既に作ってある場合：一時停止していたら再開
      if (audio.ctx.state === "suspended") audio.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window["webkitAudioContext"];
    if (!AC) return;

    audio.ctx = new AC();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.55;
    audio.master.connect(audio.ctx.destination);

    setupEngineSound();
    setupBGM();
    audio.enabled = true;
    startBGM();
  }

  // エンジン音は2つのオシレーターを重ねて作ります
  function setupEngineSound() {
    const engineGain = audio.ctx.createGain();
    engineGain.gain.value = 0;
    engineGain.connect(audio.master);

    // 主音（ノコギリ波）
    const osc1 = audio.ctx.createOscillator();
    osc1.type = "sawtooth";
    osc1.frequency.value = 60;
    osc1.connect(engineGain);
    osc1.start();

    // 倍音（四角波で少し弱め）
    const osc2 = audio.ctx.createOscillator();
    osc2.type = "square";
    osc2.frequency.value = 90;
    const osc2Gain = audio.ctx.createGain();
    osc2Gain.gain.value = 0.35;
    osc2.connect(osc2Gain).connect(engineGain);
    osc2.start();

    // 周波数を細かく揺らす（LFO）ことでリアルな唸り音にする
    const lfo = audio.ctx.createOscillator();
    const lfoGain = audio.ctx.createGain();
    lfo.frequency.value = 7;
    lfoGain.gain.value = 4;
    lfo.connect(lfoGain).connect(osc1.frequency);
    lfo.start();

    audio.engine.osc1 = osc1;
    audio.engine.osc2 = osc2;
    audio.engine.gain = engineGain;
  }

  function setupBGM() {
    const bgmGain = audio.ctx.createGain();
    bgmGain.gain.value = 0.18;
    bgmGain.connect(audio.master);
    audio.bgm.gain = bgmGain;
  }

  // 1音を指定時刻に鳴らす（オシレーターで合成）
  function playTone(freq, startTime, duration, type, vol) {
    if (!freq || !audio.enabled) return;
    const osc = audio.ctx.createOscillator();
    const g = audio.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(g).connect(audio.bgm.gain);
    // 一瞬で立ち上げて、終わりはふわっと消す（プチッというノイズ防止）
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(vol, startTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  // バスドラム：周波数を一瞬で下げると「ドンッ」と鳴る
  function playKick(time) {
    if (!audio.enabled) return;
    const osc = audio.ctx.createOscillator();
    const g = audio.ctx.createGain();
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.13);
    g.gain.setValueAtTime(0.5, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    osc.connect(g).connect(audio.bgm.gain);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  // ハイハット：短いノイズを高音だけ残してチッと鳴らす
  function playHat(time) {
    if (!audio.enabled) return;
    const bufferSize = audio.ctx.sampleRate * 0.05;
    const buffer = audio.ctx.createBuffer(1, bufferSize, audio.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++)
      data[i] = (Math.random() * 2 - 1) * 0.5;

    const noise = audio.ctx.createBufferSource();
    noise.buffer = buffer;
    const hp = audio.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 6000;
    const g = audio.ctx.createGain();
    g.gain.setValueAtTime(0.15, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    noise.connect(hp).connect(g).connect(audio.bgm.gain);
    noise.start(time);
    noise.stop(time + 0.06);
  }

  // BGMを「少し先まで予約しておく」方式で再生する
  function scheduleBGM() {
    if (!audio.enabled) return;
    const lookahead = 0.25; // 0.25秒先までは予約しておく
    while (audio.bgm.time < audio.ctx.currentTime + lookahead) {
      const t = audio.bgm.time;
      const step = audio.bgm.step;

      // メロディ
      const m = PATTERN_MEL[step % PATTERN_MEL.length];
      if (m != null) playTone(midiToFreq(m), t, STEP * 0.85, "square", 0.07);

      // アルペジオ（1オクターブ上）
      const a = PATTERN_ARP[step % PATTERN_ARP.length];
      if (a != null)
        playTone(midiToFreq(a + 12), t, STEP * 0.5, "triangle", 0.04);

      // ベースは4分音符ごと
      if (step % 2 === 0) {
        const b = PATTERN_BASS[(step / 2) % PATTERN_BASS.length];
        playTone(midiToFreq(b), t, BEAT * 0.9, "sawtooth", 0.09);
      }

      // ドラム
      if (step % 4 === 0) playKick(t);
      playHat(t);

      audio.bgm.time += STEP;
      audio.bgm.step += 1;
    }
  }

  function startBGM() {
    if (!audio.enabled) return;
    audio.bgm.time = audio.ctx.currentTime + 0.1;
    audio.bgm.step = 0;
    if (audio.bgm.timerId) clearInterval(audio.bgm.timerId);
    audio.bgm.timerId = setInterval(scheduleBGM, 60);
  }

  // 毎フレーム呼んでエンジン音の周波数と音量を更新
  function updateEngineSound() {
    if (!audio.enabled) return;
    const t = audio.ctx.currentTime;
    const pct = player.speed / MAX_SPEED;
    const idle = 55; // 停止時の周波数
    const maxF = 240; // 最高速時の周波数
    const target = idle + (maxF - idle) * pct;

    audio.engine.osc1.frequency.setTargetAtTime(target, t, 0.08);
    audio.engine.osc2.frequency.setTargetAtTime(target * 1.5, t, 0.08);

    const gain = state.running && !state.finished ? 0.14 + pct * 0.14 : 0.05;
    audio.engine.gain.gain.setTargetAtTime(gain, t, 0.1);
  }

  function setMuted(muted) {
    audio.muted = muted;
    if (!audio.enabled) return;
    audio.master.gain.setTargetAtTime(
      muted ? 0 : 0.55,
      audio.ctx.currentTime,
      0.05,
    );
  }

  // ===========================================================================
  //  7. 更新処理（毎フレームの動きの計算）
  // ===========================================================================

  // アクセル・ブレーキを反映
  function applyAccelAndBrake(dt) {
    if (keys.up) {
      const boost = keys.turbo ? TURBO_BOOST : 1;
      player.speed += ACCEL * boost * dt;
    } else if (keys.down) {
      player.speed += BRAKING * dt;
    } else {
      player.speed += DECEL * dt;
    }

    // コース外を走ると追加で減速
    if ((player.x < -1 || player.x > 1) && player.speed > OFFROAD_LIMIT) {
      player.speed += OFFROAD_DECEL * dt;
    }

    // 速度を 0〜MAX_SPEED の範囲に収める
    player.speed = Math.max(0, Math.min(MAX_SPEED, player.speed));
  }

  // ハンドルとカーブの遠心力を反映
  function applySteering(dt, playerSegment) {
    const speedPercent = player.speed / MAX_SPEED;
    const dx = dt * 2 * speedPercent; // 速いほどよく曲がる

    if (keys.left) player.x -= dx;
    if (keys.right) player.x += dx;

    // カーブを走ると外側に押される
    player.x -= dx * speedPercent * playerSegment.curve * CENTRIFUGAL;

    // コース外にも一定範囲は出られる
    player.x = Math.max(-2.5, Math.min(2.5, player.x));
  }

  // 他車・木との衝突をチェック
  function checkCollisions(dt, playerSegment) {
    // 他車：速度を落として、少しだけ横にはじき返す
    for (const car of playerSegment.cars) {
      if (Math.abs(player.x - car.offset) < CAR_HIT_WIDTH) {
        player.speed = Math.min(player.speed, OFFROAD_LIMIT);
        player.x += (player.x < car.offset ? -1 : 1) * dt * 0.5;
        break;
      }
    }
    // 木：速度を大きく落とす
    for (const sp of playerSegment.sprites) {
      if (Math.abs(player.x - sp.offset) < TREE_HIT_WIDTH) {
        player.speed = Math.min(player.speed, OFFROAD_LIMIT / 2);
        break;
      }
    }
  }

  // 他の車を進める。次のセグメントに移った車はあとでまとめて引っ越す
  // （ループ中にcarsを書き換えると二重処理してしまうため）
  function moveOpponentCars(dt) {
    const moves = [];
    for (const seg of segments) {
      for (const car of seg.cars) {
        car.z += car.speed * dt;
        if (car.z >= SEGMENT_LENGTH) {
          car.z -= SEGMENT_LENGTH;
          moves.push({
            car,
            from: seg,
            to: segments[(seg.index + 1) % segments.length],
          });
        }
      }
    }
    for (const m of moves) {
      const i = m.from.cars.indexOf(m.car);
      if (i !== -1) m.from.cars.splice(i, 1);
      m.to.cars.push(m.car);
    }
  }

  // プレイヤーの位置をコース上で進める。1周したらラップを増やす
  function advancePlayerZ(dt) {
    player.z += player.speed * dt;
    if (player.z >= state.courseLength) {
      player.z -= state.courseLength;
      state.lap += 1;
      if (state.lap > TOTAL_LAPS) finish();
    }
  }

  // 1フレームのまとめ役
  function update(dt) {
    if (!state.running || state.finished) return;
    state.elapsed += dt;

    const playerSegment = findSegment(player.z);
    applyAccelAndBrake(dt);
    applySteering(dt, playerSegment);
    checkCollisions(dt, playerSegment);
    moveOpponentCars(dt);
    advancePlayerZ(dt);
  }

  // ===========================================================================
  //  8. 描画
  // ===========================================================================

  // ---------- 8.1 描画の補助関数 -------------------------------------------
  //
  //  project() は3D座標(world)を画面座標(screen)に変換します。
  //  考え方：「遠くにあるものは小さく見える」
  //   → screen.scale = カメラの奥行き ÷ そのポイントまでの距離
  //   → 横位置(x) と 縦位置(y) と 道路の幅(w) を scale 倍して画面上に置く
  function project(
    p,
    cameraX,
    cameraY,
    cameraZ,
    cameraDepth,
    width,
    height,
    roadWidth,
  ) {
    p.camera.x = (p.world.x || 0) - cameraX;
    p.camera.y = (p.world.y || 0) - cameraY;
    p.camera.z = (p.world.z || 0) - cameraZ;
    p.screen.scale = cameraDepth / p.camera.z;
    p.screen.x = Math.round(
      width / 2 + (p.screen.scale * p.camera.x * width) / 2,
    );
    p.screen.y = Math.round(
      height / 2 - (p.screen.scale * p.camera.y * height) / 2,
    );
    p.screen.w = Math.round((p.screen.scale * roadWidth * width) / 2);
  }

  // 4つの座標で四角を塗る
  function drawPolygon(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  // ---------- 8.2 空・道路 -------------------------------------------------

  function drawSky() {
    // 空のグラデーション
    const grad = ctx.createLinearGradient(0, 0, 0, H * 0.6);
    grad.addColorStop(0, "#0d2a4d");
    grad.addColorStop(0.5, "#1a4f8a");
    grad.addColorStop(1, "#f0a070");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 太陽
    ctx.fillStyle = "rgba(255, 230, 200, 0.9)";
    ctx.beginPath();
    ctx.arc(W * 0.7, H * 0.42, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 180, 120, 0.25)";
    ctx.beginPath();
    ctx.arc(W * 0.7, H * 0.42, 100, 0, Math.PI * 2);
    ctx.fill();

    // 遠くの山影（プレイヤーの横位置に応じて少しずれる＝パララックス）
    const parallax = -player.x * 50;
    ctx.fillStyle = "rgba(20, 30, 60, 0.6)";
    ctx.beginPath();
    ctx.moveTo(0, H * 0.55);
    for (let i = 0; i <= 12; i++) {
      const px = (W / 12) * i + parallax;
      const py = H * 0.55 - Math.sin(i * 1.3) * 30 - 30;
      ctx.lineTo(px, py);
    }
    ctx.lineTo(W, H * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  // 1つのセグメント（道路の小区間）を草・縁石・路面・レーンラインの順に描く
  function drawRoadSegment(x1, y1, w1, x2, y2, w2, color) {
    const rumble1 = Math.max(6, w1 / 30);
    const rumble2 = Math.max(6, w2 / 30);
    const laneW1 = Math.max(1, w1 / 200);
    const laneW2 = Math.max(1, w2 / 200);

    // 草
    ctx.fillStyle = color.grass;
    ctx.fillRect(0, y2, W, y1 - y2);

    // 縁石（左右）
    drawPolygon(
      x1 - w1 - rumble1,
      y1,
      x1 - w1,
      y1,
      x2 - w2,
      y2,
      x2 - w2 - rumble2,
      y2,
      color.rumble,
    );
    drawPolygon(
      x1 + w1 + rumble1,
      y1,
      x1 + w1,
      y1,
      x2 + w2,
      y2,
      x2 + w2 + rumble2,
      y2,
      color.rumble,
    );

    // 路面
    drawPolygon(x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2, color.road);

    // 車線（中央のライン）
    if (color.lane !== "transparent") {
      for (let lane = 1; lane < LANES; lane++) {
        const lx1 = x1 - w1 + (lane * (2 * w1)) / LANES;
        const lx2 = x2 - w2 + (lane * (2 * w2)) / LANES;
        drawPolygon(
          lx1 - laneW1 / 2,
          y1,
          lx1 + laneW1 / 2,
          y1,
          lx2 + laneW2 / 2,
          y2,
          lx2 - laneW2 / 2,
          y2,
          color.lane,
        );
      }
    }
  }

  // ---------- 8.3 道路脇の木・茂み・他車 -----------------------------------

  function drawTreeOrBush(sprite) {
    const destW = sprite.screen.w;
    const destH = sprite.screen.w * 1.4;
    const destX = sprite.screen.x - destW / 2;
    const destY = sprite.screen.y - destH;

    if (sprite.type === "tree") {
      // 幹
      ctx.fillStyle = "#5b3a1e";
      ctx.fillRect(
        destX + destW * 0.4,
        destY + destH * 0.6,
        destW * 0.2,
        destH * 0.4,
      );
      // 葉（2層で立体感）
      ctx.fillStyle = COLORS.TREE;
      ctx.beginPath();
      ctx.arc(
        destX + destW / 2,
        destY + destH * 0.45,
        destW * 0.55,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.fillStyle = "#0d7a3a";
      ctx.beginPath();
      ctx.arc(
        destX + destW * 0.35,
        destY + destH * 0.55,
        destW * 0.4,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else {
      // 茂み
      ctx.fillStyle = "#1a8838";
      ctx.beginPath();
      ctx.ellipse(
        destX + destW / 2,
        destY + destH * 0.85,
        destW * 0.55,
        destH * 0.35,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  // 対向車（後ろから見たスポーツカー）
  function drawOpponentCar(seg, car) {
    const w = seg.p1.screen.w * 0.62;
    const h = w * 0.7;
    const x = car.screenX - w / 2;
    const y = car.screenY - h;

    // 路面に落ちる影
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.ellipse(
      car.screenX,
      car.screenY,
      w * 0.55,
      h * 0.14,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    // リアディフューザー（黒い下部）
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.moveTo(x + w * 0.08, y + h * 0.82);
    ctx.lineTo(x + w * 0.92, y + h * 0.82);
    ctx.lineTo(x + w * 0.86, y + h * 0.98);
    ctx.lineTo(x + w * 0.14, y + h * 0.98);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#1f1f1f";
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(x + w * (0.3 + i * 0.13), y + h * 0.85, w * 0.02, h * 0.1);
    }
    // 排気管
    ctx.fillStyle = "#888";
    ctx.beginPath();
    ctx.arc(x + w * 0.22, y + h * 0.88, h * 0.06, 0, Math.PI * 2);
    ctx.arc(x + w * 0.78, y + h * 0.88, h * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.arc(x + w * 0.22, y + h * 0.88, h * 0.035, 0, Math.PI * 2);
    ctx.arc(x + w * 0.78, y + h * 0.88, h * 0.035, 0, Math.PI * 2);
    ctx.fill();

    // ボディ（台形）にグラデで丸み
    const bodyGrad = ctx.createLinearGradient(0, y + h * 0.3, 0, y + h * 0.82);
    bodyGrad.addColorStop(0, car.color);
    bodyGrad.addColorStop(0.55, car.color);
    bodyGrad.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.04, y + h * 0.82);
    ctx.lineTo(x + w * 0.1, y + h * 0.45);
    ctx.lineTo(x + w * 0.18, y + h * 0.32);
    ctx.lineTo(x + w * 0.82, y + h * 0.32);
    ctx.lineTo(x + w * 0.9, y + h * 0.45);
    ctx.lineTo(x + w * 0.96, y + h * 0.82);
    ctx.closePath();
    ctx.fill();
    // ボディ上面ハイライト
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(x + w * 0.18, y + h * 0.33);
    ctx.lineTo(x + w * 0.82, y + h * 0.33);
    ctx.lineTo(x + w * 0.78, y + h * 0.38);
    ctx.lineTo(x + w * 0.22, y + h * 0.38);
    ctx.closePath();
    ctx.fill();

    // ルーフ
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.moveTo(x + w * 0.22, y + h * 0.33);
    ctx.lineTo(x + w * 0.3, y + h * 0.05);
    ctx.lineTo(x + w * 0.7, y + h * 0.05);
    ctx.lineTo(x + w * 0.78, y + h * 0.33);
    ctx.closePath();
    ctx.fill();
    // リアウィンドウ
    const winGrad = ctx.createLinearGradient(0, y + h * 0.08, 0, y + h * 0.32);
    winGrad.addColorStop(0, "#0a1a2a");
    winGrad.addColorStop(1, "#6090c0");
    ctx.fillStyle = winGrad;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.27, y + h * 0.31);
    ctx.lineTo(x + w * 0.33, y + h * 0.09);
    ctx.lineTo(x + w * 0.67, y + h * 0.09);
    ctx.lineTo(x + w * 0.73, y + h * 0.31);
    ctx.closePath();
    ctx.fill();
    // ウィンドウのハイライト
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(x + w * 0.34, y + h * 0.11);
    ctx.lineTo(x + w * 0.48, y + h * 0.11);
    ctx.lineTo(x + w * 0.42, y + h * 0.2);
    ctx.lineTo(x + w * 0.3, y + h * 0.2);
    ctx.closePath();
    ctx.fill();

    // リアスポイラー
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(x + w * 0.15, y + h * 0.3, w * 0.7, h * 0.06);
    ctx.fillRect(x + w * 0.16, y + h * 0.22, w * 0.05, h * 0.1);
    ctx.fillRect(x + w * 0.79, y + h * 0.22, w * 0.05, h * 0.1);

    // テールライト
    ctx.fillStyle = "#220404";
    ctx.fillRect(x + w * 0.08, y + h * 0.55, w * 0.84, h * 0.09);
    ctx.fillStyle = "#ff2020";
    ctx.fillRect(x + w * 0.1, y + h * 0.57, w * 0.36, h * 0.05);
    ctx.fillRect(x + w * 0.54, y + h * 0.57, w * 0.36, h * 0.05);
    ctx.fillStyle = "rgba(255,80,80,0.6)";
    ctx.fillRect(x + w * 0.1, y + h * 0.58, w * 0.36, h * 0.02);
    ctx.fillRect(x + w * 0.54, y + h * 0.58, w * 0.36, h * 0.02);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + w * 0.46, y + h * 0.575, w * 0.08, h * 0.025);

    // ナンバープレート
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + w * 0.42, y + h * 0.66, w * 0.16, h * 0.09);
    ctx.fillStyle = "#222";
    ctx.fillRect(x + w * 0.435, y + h * 0.67, w * 0.13, h * 0.07);

    // タイヤとハブ
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.ellipse(
      x + w * 0.13,
      y + h * 0.78,
      w * 0.07,
      h * 0.1,
      0,
      0,
      Math.PI * 2,
    );
    ctx.ellipse(
      x + w * 0.87,
      y + h * 0.78,
      w * 0.07,
      h * 0.1,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.fillStyle = "#444";
    ctx.beginPath();
    ctx.arc(x + w * 0.13, y + h * 0.78, w * 0.025, 0, Math.PI * 2);
    ctx.arc(x + w * 0.87, y + h * 0.78, w * 0.025, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- 8.4 プレイヤーの車（コックピット視点）-----------------------
  //  drawPlayerCarの中で、ボンネット→ダッシュ→ハンドル→メーター→ミラー
  //  と順番に重ねて描いていきます。

  function drawHoodAndFenders() {
    // 路面に落ちる影
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.ellipse(0, 0, 320, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // 車体本体（赤いグラデで膨らみを表現）
    const bodyGrad = ctx.createLinearGradient(0, -195, 0, 0);
    bodyGrad.addColorStop(0, "#ff3838");
    bodyGrad.addColorStop(0.4, "#cc0a18");
    bodyGrad.addColorStop(0.8, "#660008");
    bodyGrad.addColorStop(1, "#2a0006");
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(-380, 10);
    ctx.lineTo(-340, -100);
    ctx.lineTo(-300, -180);
    ctx.lineTo(-220, -195);
    ctx.lineTo(220, -195);
    ctx.lineTo(300, -180);
    ctx.lineTo(340, -100);
    ctx.lineTo(380, 10);
    ctx.closePath();
    ctx.fill();

    // フェンダーのハイライト（左右）
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    [
      [-340, -300, -275, -318],
      [340, 300, 275, 318],
    ].forEach(([a, b, c, d]) => {
      ctx.beginPath();
      ctx.moveTo(a, -90);
      ctx.lineTo(b, -180);
      ctx.lineTo(c, -180);
      ctx.lineTo(d, -90);
      ctx.closePath();
      ctx.fill();
    });

    // 中央の凹みラインと、その上のクロームライン
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.moveTo(-40, -195);
    ctx.lineTo(40, -195);
    ctx.lineTo(70, 5);
    ctx.lineTo(-70, 5);
    ctx.closePath();
    ctx.fill();
    const chromeGrad = ctx.createLinearGradient(-6, 0, 6, 0);
    chromeGrad.addColorStop(0, "#888");
    chromeGrad.addColorStop(0.5, "#fff");
    chromeGrad.addColorStop(1, "#666");
    ctx.fillStyle = chromeGrad;
    ctx.beginPath();
    ctx.moveTo(-4, -195);
    ctx.lineTo(4, -195);
    ctx.lineTo(6, 0);
    ctx.lineTo(-6, 0);
    ctx.closePath();
    ctx.fill();
  }

  function drawAirIntakes() {
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.moveTo(-110, -188);
    ctx.lineTo(-50, -188);
    ctx.lineTo(-58, -170);
    ctx.lineTo(-115, -170);
    ctx.closePath();
    ctx.moveTo(110, -188);
    ctx.lineTo(50, -188);
    ctx.lineTo(58, -170);
    ctx.lineTo(115, -170);
    ctx.closePath();
    ctx.fill();
    // 内側の細いメッシュ線
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(-110 + i * 10, -188);
      ctx.lineTo(-115 + i * 10, -170);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(60 + i * 10, -188);
      ctx.lineTo(58 + i * 10, -170);
      ctx.stroke();
    }
  }

  function drawRacingStripesAndNumber() {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(-180, -195, 8, 200);
    ctx.fillRect(172, -195, 8, 200);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(-172, -195, 4, 200);
    ctx.fillRect(168, -195, 4, 200);

    // ナンバー "07"
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "bold 56px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("07", -240, -100);
    ctx.fillText("07", 240, -100);
  }

  function drawDashboardStrip() {
    const dashGrad = ctx.createLinearGradient(0, -240, 0, -195);
    dashGrad.addColorStop(0, "#0a0a0a");
    dashGrad.addColorStop(1, "#2a2a2a");
    ctx.fillStyle = dashGrad;
    ctx.beginPath();
    ctx.moveTo(-260, -195);
    ctx.lineTo(260, -195);
    ctx.lineTo(240, -240);
    ctx.lineTo(-240, -240);
    ctx.closePath();
    ctx.fill();

    // ステッチ（破線）
    ctx.strokeStyle = "rgba(220,180,60,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(-240, -239);
    ctx.lineTo(240, -239);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 円形ゲージを1個描く
  function drawGauge(cx, cy, speedPct, normalColor, dangerColor) {
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(
      cx,
      cy,
      17,
      Math.PI * 0.75,
      Math.PI * 0.75 + Math.PI * 1.5 * speedPct,
    );
    ctx.strokeStyle = speedPct > 0.8 ? dangerColor : normalColor;
    ctx.stroke();
  }

  function drawCockpitGauges(speedPct) {
    drawGauge(-180, -217, speedPct, "#00d0ff", "#ff3030");
    drawGauge(180, -217, speedPct, "#ff8800", "#ff3030");

    // 中央のデジタル速度表示
    ctx.fillStyle = "#000";
    ctx.fillRect(-55, -232, 110, 28);
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.strokeRect(-55, -232, 110, 28);
    ctx.fillStyle = speedPct > 0.85 ? "#ff3030" : "#00ff88";
    ctx.font = "bold 18px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(speedPct * 280)} km/h`, 0, -218);
  }

  function drawSteeringWheel(cx, cy, angle) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // ステアリングコラム（下から伸びる軸）
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(-12, 0, 24, 120);

    // 外周リム（黒革）
    ctx.strokeStyle = "#0a0a0a";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(0, 0, 78, 0, Math.PI * 2);
    ctx.stroke();

    // ステッチ
    ctx.strokeStyle = "rgba(220,180,60,0.6)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(0, 0, 70, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 上部のハイライト
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 86, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();

    // 3本のスポーク
    ctx.fillStyle = "#1a1a1a";
    [
      [-70, -14, -18, -8, -18, 8, -70, 14],
      [70, -14, 18, -8, 18, 8, 70, 14],
      [-14, 18, 14, 18, 18, 70, -18, 70],
    ].forEach((s) => {
      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[2], s[3]);
      ctx.lineTo(s[4], s[5]);
      ctx.lineTo(s[6], s[7]);
      ctx.closePath();
      ctx.fill();
    });

    // スポークのハイライト
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(-65, -12, 50, 3);
    ctx.fillRect(15, -12, 50, 3);

    // パドルシフト（銀色のスイッチ）
    ctx.fillStyle = "#888";
    ctx.fillRect(-55, -35, 25, 8);
    ctx.fillRect(30, -35, 25, 8);

    // 中央のエンブレム
    ctx.fillStyle = "#2a2a2a";
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    const emblemGrad = ctx.createRadialGradient(0, 0, 4, 0, 0, 22);
    emblemGrad.addColorStop(0, "#ff4040");
    emblemGrad.addColorStop(1, "#660000");
    ctx.fillStyle = emblemGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("R", 0, 1);

    ctx.restore();
  }

  function drawMirror(x, y, side) {
    ctx.save();
    ctx.translate(x, y);

    // ステイ（取り付け部分）
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.moveTo(side * -4, 26);
    ctx.lineTo(side * 4, 26);
    ctx.lineTo(side * 10, 0);
    ctx.lineTo(side * -2, 0);
    ctx.closePath();
    ctx.fill();

    // ミラーのハウジング
    ctx.fillStyle = "#cc1818";
    ctx.beginPath();
    ctx.ellipse(0, -6, 36, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(0, 2, 32, 18, 0, 0, Math.PI);
    ctx.fill();

    // 鏡面（空とアスファルトのグラデで反射を表現）
    const g = ctx.createLinearGradient(0, -28, 0, 12);
    g.addColorStop(0, "#1a4f8a");
    g.addColorStop(0.55, "#82c8ff");
    g.addColorStop(0.6, "#6b6b6b");
    g.addColorStop(1, "#3a3a3a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -6, 28, 19, 0, 0, Math.PI * 2);
    ctx.fill();

    // 反射ハイライト
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.beginPath();
    ctx.ellipse(-12, -14, 10, 4, -0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // 自分の車（コックピット）を描く本体
  function drawPlayerCar() {
    // スピードに応じた微振動と、ハンドル方向への傾き
    const wobble =
      Math.sin(performance.now() / 60) * (player.speed / MAX_SPEED) * 2;
    const turn = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
    const tilt = turn * 10;
    const wheelAng = turn * 0.4;
    const speedPct = player.speed / MAX_SPEED;

    ctx.save();
    ctx.translate(W / 2 + tilt, H + wobble);

    drawHoodAndFenders();
    drawAirIntakes();
    drawRacingStripesAndNumber();
    drawDashboardStrip();
    drawSteeringWheel(0, -90, wheelAng);
    drawCockpitGauges(speedPct);
    drawMirror(-300, -195, -1);
    drawMirror(300, -195, 1);

    ctx.restore();
  }

  // ---------- 8.5 1フレーム分の描画 ---------------------------------------
  function render() {
    drawSky();

    // カメラの位置を求める（プレイヤーの真上、CAMERA_HEIGHT分の高さ）
    const baseSegment = findSegment(player.z);
    const basePercent = (player.z % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    const playerY = easeInOut(
      baseSegment.p1.world.y,
      baseSegment.p2.world.y,
      basePercent,
    );
    const cameraZ = player.z;
    const cameraX = player.x * ROAD_WIDTH;
    const cameraY = playerY + CAMERA_HEIGHT;

    // 道路セグメントを「近い→遠い」の順に描く。
    // maxY を更新していき、すでに描いた近い丘より高い位置にあるものは
    // 描かない（手前の丘で隠れている部分の上書きを防ぐ）。
    let maxY = H;
    let x = 0;
    let dx = -(baseSegment.curve * basePercent);

    for (let n = 0; n < DRAW_DISTANCE; n++) {
      const segIdx = (baseSegment.index + n) % segments.length;
      const seg = segments[segIdx];
      // コースの最後を回り込んだ場合はZを補正する
      const looped = segIdx < baseSegment.index;
      const camZ = cameraZ - (looped ? segments.length * SEGMENT_LENGTH : 0);

      project(
        seg.p1,
        cameraX - x,
        cameraY,
        camZ,
        CAMERA_DEPTH,
        W,
        H,
        ROAD_WIDTH,
      );
      project(
        seg.p2,
        cameraX - x - dx,
        cameraY,
        camZ,
        CAMERA_DEPTH,
        W,
        H,
        ROAD_WIDTH,
      );

      x += dx;
      dx += seg.curve;

      // 後でスプライト描画にも使えるよう、クリップ位置を覚えておく
      seg.clip = maxY;

      // 描く必要が無い（カメラより後ろ／手前の丘で隠れている）ものはスキップ
      if (
        seg.p1.camera.z <= CAMERA_DEPTH ||
        seg.p2.screen.y >= seg.p1.screen.y ||
        seg.p2.screen.y >= maxY
      )
        continue;

      drawRoadSegment(
        seg.p1.screen.x,
        seg.p1.screen.y,
        seg.p1.screen.w,
        seg.p2.screen.x,
        seg.p2.screen.y,
        seg.p2.screen.w,
        seg.color,
      );

      // 遠くは霧で薄くする
      if (n > DRAW_DISTANCE - 50) {
        const fogAlpha = (n - (DRAW_DISTANCE - 50)) / 50;
        ctx.fillStyle = `rgba(180, 210, 240, ${fogAlpha * 0.6})`;
        ctx.fillRect(0, seg.p2.screen.y, W, seg.p1.screen.y - seg.p2.screen.y);
      }

      maxY = seg.p1.screen.y;
    }

    // スプライトと他車は「遠い→近い」の順で描く（近いものが手前に出るように）
    for (let n = DRAW_DISTANCE - 1; n >= 0; n--) {
      const segIdx = (baseSegment.index + n) % segments.length;
      const seg = segments[segIdx];

      for (const sprite of seg.sprites) {
        const sx = seg.p1.screen.x + seg.p1.screen.w * sprite.offset * 2;
        const sy = seg.p1.screen.y;
        if (seg.p1.screen.scale > 0 && sy < seg.clip) {
          sprite.screen = {
            x: sx,
            y: sy,
            w: (seg.p1.screen.scale * 600 * W) / 2,
          };
          drawTreeOrBush(sprite);
        }
      }

      for (const car of seg.cars) {
        const cx = seg.p1.screen.x + seg.p1.screen.w * car.offset * 2;
        const cy = seg.p1.screen.y;
        if (seg.p1.screen.scale > 0 && cy < seg.clip) {
          car.screenX = cx;
          car.screenY = cy;
          drawOpponentCar(seg, car);
        }
      }
    }

    // 最後に自分の車（一人称ボンネット）
    drawPlayerCar();
  }

  // ===========================================================================
  //  9. HUD（画面端の数字表示）
  // ===========================================================================
  function updateHUD() {
    const kmh = Math.round((player.speed / MAX_SPEED) * 280);
    speedEl.textContent = kmh;
    lapEl.textContent = `${Math.min(state.lap, TOTAL_LAPS)} / ${TOTAL_LAPS}`;
    timeEl.textContent = state.elapsed.toFixed(2);
    bestEl.textContent =
      state.bestTime == null ? "--.--" : state.bestTime.toFixed(2);

    const pct = (player.speed / MAX_SPEED) * 100;
    rpmFill.style.width = `${pct}%`;
    const gear = Math.min(6, Math.max(1, Math.ceil(pct / 17)));
    gearEl.textContent = gear;
  }

  // ===========================================================================
  //  10. ゲームループ（毎フレーム呼ばれる）
  // ===========================================================================
  let lastTime = 0;

  function gameLoop(now) {
    if (!lastTime) lastTime = now;
    let dt = (now - lastTime) / 1000; // 前フレームからの経過秒
    if (dt > 0.1) dt = 0.1; // タブ切り替えで巨大な値にならないよう制限
    lastTime = now;

    update(dt);
    render();
    updateHUD();
    updateEngineSound();

    requestAnimationFrame(gameLoop);
  }

  // ===========================================================================
  //  11. 開始 / ゴール
  // ===========================================================================
  function startGame() {
    initAudio(); // 音はユーザー操作後でないと鳴らせない
    buildCourse();
    state.courseLength = segments.length * SEGMENT_LENGTH;
    state.running = true;
    state.finished = false;
    state.elapsed = 0;
    state.lap = 1;
    player.x = 0;
    player.z = 0;
    player.speed = 0;
    startScreen.classList.add("hidden");
    finishScreen.classList.add("hidden");
  }

  function finish() {
    state.running = false;
    state.finished = true;
    if (state.bestTime == null || state.elapsed < state.bestTime) {
      state.bestTime = state.elapsed;
    }
    finalTime.textContent = state.elapsed.toFixed(2);
    finalBest.textContent = state.bestTime.toFixed(2);
    finishScreen.classList.remove("hidden");
  }

  // ===========================================================================
  //  12. イベント設定 + 起動
  // ===========================================================================
  startBtn.addEventListener("click", startGame);
  restartBtn.addEventListener("click", startGame);

  buildCourse();
  state.courseLength = segments.length * SEGMENT_LENGTH;
  requestAnimationFrame(gameLoop);
})();
