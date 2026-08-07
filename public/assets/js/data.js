/* ------------------------------------------------------------------
   Placeholder data shaped exactly like the real DB tables:
     region(region_id, region_name)
     zone(zone_id, zone_name, region_id)
     woreda(woreda_id, woreda_name, zone_id)
     kebele(kebele_id, kebele_name, woreda_id)
   Swap every array below for a fetch() to your real endpoints, e.g.:
     GET /api/zonal/regions
     GET /api/zonal/zones?region_id=
     GET /api/zonal/woredas?zone_id=
     GET /api/zonal/kebeles?woreda_id=
   The cascading <select> logic in app.js already expects this exact
   shape, so no other change is needed once real data is wired in.
------------------------------------------------------------------- */

const REGIONS = [
  { region_id: 1, region_name: "Gambella" },
  { region_id: 2, region_name: "Oromia" },
  { region_id: 3, region_name: "Amhara" }
];

const ZONES = [
  { zone_id: 1, zone_name: "Agnuak Zone", region_id: 1 },
  { zone_id: 2, zone_name: "Nuer Zone", region_id: 1 },
  { zone_id: 3, zone_name: "Majang Zone", region_id: 1 },
  { zone_id: 4, zone_name: "Etang Special Woreda Zone", region_id: 1 },
  { zone_id: 5, zone_name: "West Shewa Zone", region_id: 2 }
];

const WOREDAS = [
  { woreda_id: 1, woreda_name: "Gambella Zuria", zone_id: 1 },
  { woreda_id: 2, woreda_name: "Abobo", zone_id: 1 },
  { woreda_id: 3, woreda_name: "Gog", zone_id: 1 },
  { woreda_id: 4, woreda_name: "Jikawo", zone_id: 2 },
  { woreda_id: 5, woreda_name: "Lare", zone_id: 2 },
  { woreda_id: 6, woreda_name: "Godere", zone_id: 3 }
];

const KEBELES = [
  { kebele_id: 1, kebele_name: "Kebele 01", woreda_id: 1 },
  { kebele_id: 2, kebele_name: "Kebele 02", woreda_id: 1 },
  { kebele_id: 3, kebele_name: "Kebele 03", woreda_id: 1 },
  { kebele_id: 4, kebele_name: "Perbongo", woreda_id: 2 },
  { kebele_id: 5, kebele_name: "Abobo Town", woreda_id: 2 },
  { kebele_id: 6, kebele_name: "Gog Town", woreda_id: 3 },
  { kebele_id: 7, kebele_name: "Jikawo Town", woreda_id: 4 },
  { kebele_id: 8, kebele_name: "Lare Town", woreda_id: 5 }
];

const SCHOOLS = [
  { id: 1, name: "Newland Secondary School", region_id: 1, zone_id: 1, woreda_id: 1, kebele_id: 1 },
  { id: 2, name: "Abobo Preparatory School", region_id: 1, zone_id: 1, woreda_id: 2, kebele_id: 5 },
  { id: 3, name: "Itang General Secondary School", region_id: 1, zone_id: 2, woreda_id: 4, kebele_id: 7 },
  { id: 4, name: "Gambella Model High School", region_id: 1, zone_id: 1, woreda_id: 1, kebele_id: 2 }
];

const STUDENT_ROWS = [
  { school: "Newland Secondary School", class: 9, stream: "General", section: "A", male: 32, female: 29 },
  { school: "Newland Secondary School", class: 9, stream: "General", section: "B", male: 30, female: 31 },
  { school: "Newland Secondary School", class: 10, stream: "General", section: "A", male: 28, female: 34 },
  { school: "Abobo Preparatory School", class: 11, stream: "Natural", section: "A", male: 26, female: 22 },
  { school: "Abobo Preparatory School", class: 11, stream: "Social", section: "B", male: 24, female: 27 },
  { school: "Itang General Secondary School", class: 12, stream: "Natural", section: "A", male: 19, female: 21 },
  { school: "Gambella Model High School", class: 9, stream: "General", section: "C", male: 33, female: 30 }
];
