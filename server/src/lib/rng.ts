/** Small deterministic PRNG so demo/scale data is reproducible. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const pick = <T>(r: Rng, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];

export function weighted<T>(r: Rng, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x <= 0) return v;
  }
  return items[items.length - 1][0];
}

export const int = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1));

/** Exponential-ish positive sample with the given mean. */
export const expo = (r: Rng, mean: number) => -Math.log(1 - r()) * mean;

export function indianMobile(r: Rng) {
  let n = String(int(r, 6, 9));
  for (let i = 0; i < 9; i++) n += int(r, 0, 9);
  return `+91${n}`;
}

export const FIRST = ['Aarav','Vivaan','Aditya','Arjun','Rohan','Karan','Rahul','Amit','Sanjay','Vikram','Neha','Priya','Anjali','Pooja','Sneha','Kavya','Isha','Riya','Meera','Divya','Suresh','Ramesh','Manoj','Deepak','Nikhil','Shreya','Tanvi','Aishwarya','Harsh','Yash','Mohit','Gaurav','Sunita','Lakshmi','Farhan','Zoya','Imran','Nisha','Varun','Pranav'];
export const LAST = ['Sharma','Verma','Patil','Kulkarni','Deshmukh','Joshi','Iyer','Nair','Reddy','Gupta','Mehta','Shah','Desai','Bhatt','Khan','Ansari','Singh','Yadav','Chavan','More','Jadhav','Pawar','Kapoor','Malhotra','Banerjee','Das','Menon','Pillai','Naik','Gaikwad'];
