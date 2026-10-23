// Ingredient strings written for verifier tests. Marked synthetic; no Open Food Facts text.

export interface SyntheticIngredient {
  id: string;
  text: string;
  lang: "en" | "de" | "fr" | "es" | "it";
  synthetic: true;
  note?: string;
}

export const SYNTHETIC_INGREDIENTS: SyntheticIngredient[] = [
  { id: "en-cocoa-butter", text: "cocoa butter", lang: "en", synthetic: true },
  { id: "en-coconut-milk", text: "coconut milk", lang: "en", synthetic: true },
  { id: "de-kakaobutter", text: "Kakaobutter", lang: "de", synthetic: true },
  { id: "de-kokosmilch", text: "Kokosmilch", lang: "de", synthetic: true },
  { id: "en-buckwheat", text: "buckwheat", lang: "en", synthetic: true },
  { id: "de-buchweizen", text: "Buchweizen", lang: "de", synthetic: true },
  { id: "it-grano-saraceno", text: "grano saraceno", lang: "it", synthetic: true },
  { id: "en-nutmeg", text: "nutmeg", lang: "en", synthetic: true },
  { id: "de-muskatnuss", text: "Muskatnuss", lang: "de", synthetic: true },
  { id: "fr-noix-muscade", text: "noix de muscade", lang: "fr", synthetic: true },
  { id: "es-nuez-moscada", text: "nuez moscada", lang: "es", synthetic: true },
  { id: "en-butternut", text: "butternut squash", lang: "en", synthetic: true },
  { id: "en-cream-tartar", text: "cream of tartar", lang: "en", synthetic: true },
  { id: "en-lactic-acid", text: "lactic acid", lang: "en", synthetic: true },
  { id: "de-milchsaeure", text: "Milchsäure", lang: "de", synthetic: true },
  { id: "de-erdnuss", text: "Erdnuss", lang: "de", synthetic: true },
  { id: "de-milcheiweiss", text: "Milcheiweiß", lang: "de", synthetic: true },
  { id: "de-weizen", text: "Weizen", lang: "de", synthetic: true },
  { id: "en-eggplant", text: "eggplant", lang: "en", synthetic: true },
  { id: "en-peanut-butter", text: "peanut butter", lang: "en", synthetic: true },
  { id: "en-nut-free", text: "nut-free", lang: "en", synthetic: true },
  { id: "en-lactose-free-milk", text: "lactose-free milk", lang: "en", synthetic: true },
  { id: "fr-noix-coco", text: "noix de coco", lang: "fr", synthetic: true },
  { id: "de-kokosnuss", text: "Kokosnuss", lang: "de", synthetic: true },
  { id: "it-noce-cocco", text: "noce di cocco", lang: "it", synthetic: true },
  { id: "en-may-contain-milk", text: "may contain milk", lang: "en", synthetic: true },
  {
    id: "en-may-contain-list",
    text: "May contain milk, peanuts and nuts. Salt.",
    lang: "en",
    synthetic: true,
  },
  {
    id: "de-spuren",
    text: "Kann Spuren von Milch und Haselnüssen enthalten",
    lang: "de",
    synthetic: true,
  },
  { id: "fr-peut-contenir", text: "Peut contenir des traces de lait", lang: "fr", synthetic: true },
  { id: "fr-traces-eventuelles", text: "Traces éventuelles de lait", lang: "fr", synthetic: true },
  { id: "es-puede-contener", text: "Puede contener trazas de leche", lang: "es", synthetic: true },
  { id: "it-puo-contenere", text: "Può contenere tracce di latte", lang: "it", synthetic: true },
  {
    id: "en-flour-then-may",
    text: "wheat flour. May contain milk.",
    lang: "en",
    synthetic: true,
  },
  { id: "de-weizenmehl", text: "Weizenmehl", lang: "de", synthetic: true },
  { id: "fr-farine-ble", text: "farine de blé", lang: "fr", synthetic: true },
  { id: "es-harina-trigo", text: "harina de trigo", lang: "es", synthetic: true },
  { id: "it-farina-grano", text: "farina di grano tenero", lang: "it", synthetic: true },
  { id: "de-haselnuesse", text: "Haselnüsse", lang: "de", synthetic: true },
  { id: "fr-noisettes", text: "noisettes", lang: "fr", synthetic: true },
  { id: "es-avellanas", text: "avellanas", lang: "es", synthetic: true },
  { id: "it-nocciole", text: "nocciole", lang: "it", synthetic: true },
  { id: "de-sojalecithin", text: "Sojalecithin", lang: "de", synthetic: true },
  { id: "fr-lecithine-soja", text: "lécithine de soja", lang: "fr", synthetic: true },
  { id: "en-wheat-flour", text: "wheat flour", lang: "en", synthetic: true },
  { id: "en-whole-milk", text: "whole milk powder", lang: "en", synthetic: true },
];
