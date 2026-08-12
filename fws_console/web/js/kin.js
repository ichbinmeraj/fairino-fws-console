// Forward kinematics for drawing the arm, plus a check that the drawing is
// telling the truth.
//
// FWS never hardcodes robot constants it can measure instead — and the FR5
// model below is measured, not copied from a datasheet. It was fitted against
// the controller's own GetForwardKin: 59 joint configurations sampled across
// the joint space, lengths solved by least squares, convention found by
// enumeration. Residual: 0.0000 mm RMS. The chain (UR-style, all lengths mm):
//
//   Rz(q1)·Tz(152)·Rx(-90°) · Rz(-q2)·Tx(-425) · Rz(-q3)·Tx(-395)
//   · Rz(-q4)·Tz(-102)·Rx(-90°) · Rz(q5)·Tz(102)·Rx(-90°) · Rz(q6)·Tz(100)
//
// agreement() still compares the model's TCP against the controller's
// reported TCP on every frame — the badge is the proof, not the pedigree.
//
// The 'sim' model reproduces fws/testing/kinematics.py exactly; it is what
// `fws --simulator` really computes and is deliberately not an FR5.

const RAD = Math.PI / 180;

// --- tiny 3x3 helpers ----------------------------------------------------

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function rz(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
function rx(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
function mul(A, B) {
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return R;
}
function apply(A, v) {
  return [
    A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
    A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
    A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
  ];
}

/**
 * A model maps joint angles (degrees) to the 3D origin of each link, in mm,
 * z up, base at the origin. The last point is the TCP. `toolOffset` is the
 * active tool frame's [x,y,z,...] offset in the flange frame, if known.
 */
export const MODELS = {
  sim: {
    id: 'sim',
    label: 'FWS simulator',
    provenance: 'exact',
    note: 'Simulator kinematics — schematic display, not an FR5 model.',
    reach: 920,
    points(joints) {
      const [j1, j2, j3] = joints.slice(0, 3).map((d) => d * RAD);
      const D1 = 152, A2 = 425, A3 = 395, D6 = 100;

      const c1 = Math.cos(j1), s1 = Math.sin(j1);
      const r2 = A2 * Math.cos(j2);
      const z2 = D1 + A2 * Math.sin(j2);
      const r3 = r2 + A3 * Math.cos(j2 + j3);
      const z3 = z2 + A3 * Math.sin(j2 + j3);
      const r4 = r3 + D6;

      return [
        [0, 0, 0],                    // base
        [0, 0, D1],                   // shoulder
        [r2 * c1, r2 * s1, z2],       // elbow
        [r3 * c1, r3 * s1, z3],       // wrist
        [r4 * c1, r4 * s1, z3],       // TCP
      ];
    },
  },

  fr5: {
    id: 'fr5',
    label: 'FR5 (measured)',
    provenance: 'exact',
    note: 'Fitted to this controller’s own GetForwardKin: '
        + '0.00 mm RMS over 59 sampled poses.',
    reach: 922,
    meshUrl: 'models/fr5.json',
    // Link names in fr5.json, in frame order (base + one per joint). The
    // meshes come from FAIR-INNOVATION's frcobot_description (Apache 2.0),
    // modelled directly in these link frames.
    meshLinks: ['base_link', 'j1_Link', 'j2_Link', 'j3_Link',
                'j4_Link', 'j5_Link', 'j6_Link'],

    // One chain drives everything: the mesh frames, the fallback skeleton
    // and the agreement badge. Structure follows the vendor URDF (fr5v6);
    // lengths are the controller's own (verified 0.000035 mm worst-case
    // against 59 GetForwardKin samples — the URDF's rounded 395.01/102.1
    // are measurably WORSE, so do not "correct" these to match it).
    // Per joint: translate xyz in parent frame, twist about x, then Rz(q).
    chain: [
      { xyz: [0, 0, 0],      twist: 0 },
      { xyz: [0, 0, 152],    twist: Math.PI / 2 },
      { xyz: [-425, 0, 0],   twist: 0 },
      { xyz: [-395, 0, 0],   twist: 0 },
      { xyz: [0, 0, 102],    twist: Math.PI / 2 },
      { xyz: [0, 0, 102],    twist: -Math.PI / 2 },
    ],
    flange: [0, 0, 100],

    /** World transform {R, p} of every link frame: base, j1..j6. */
    frames(joints) {
      const out = [{ R: I3, p: [0, 0, 0] }];
      let R = I3, p = [0, 0, 0];
      for (let i = 0; i < 6; i++) {
        const step = this.chain[i];
        const t = apply(R, step.xyz);
        p = [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
        if (step.twist) R = mul(R, rx(step.twist));
        R = mul(R, rz(joints[i] * RAD));
        out.push({ R, p });
      }
      return out;
    },

    points(joints, toolOffset) {
      const fr = this.frames(joints);
      const pts = fr.map((f) => f.p);
      const last = fr[fr.length - 1];
      let tip = apply(last.R, this.flange);
      tip = [last.p[0] + tip[0], last.p[1] + tip[1], last.p[2] + tip[2]];
      pts.push(tip);                                 // flange
      if (toolOffset && (toolOffset[0] || toolOffset[1] || toolOffset[2])) {
        const t = apply(last.R, toolOffset.slice(0, 3));
        pts.push([tip[0] + t[0], tip[1] + t[1], tip[2] + t[2]]);  // TCP
      }
      return pts;
    },
  },
};

/** Pick a model from the controller's reported model string. */
export function modelFor(robotModel) {
  if (!robotModel) return MODELS.sim;
  return /FR5/i.test(robotModel) ? MODELS.fr5 : MODELS.sim;
}

/**
 * How far the model's TCP is from the one the controller reports, in mm.
 * Returns null when there is nothing to compare.
 */
export function agreement(model, joints, reportedTcp, toolOffset) {
  if (!joints || !reportedTcp || joints.length < 3) return null;
  const pts = model.points(joints, toolOffset);
  const tip = pts[pts.length - 1];
  const dx = tip[0] - reportedTcp[0];
  const dy = tip[1] - reportedTcp[1];
  const dz = tip[2] - reportedTcp[2];
  return Math.hypot(dx, dy, dz);
}

/** Verdict for the badge. Thresholds are display choices, not physics. */
export function verdict(errorMm) {
  if (errorMm === null) return { level: 'unknown', text: 'no comparison yet' };
  if (errorMm < 1.0)   return { level: 'ok',      text: `matches controller (${errorMm.toFixed(2)} mm)` };
  if (errorMm < 25.0)  return { level: 'warn',    text: `${errorMm.toFixed(1)} mm from reported TCP` };
  return { level: 'bad', text: `model disagrees by ${errorMm.toFixed(0)} mm — shape only` };
}
