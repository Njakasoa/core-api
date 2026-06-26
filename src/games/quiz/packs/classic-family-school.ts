import type { Question, ThemePack } from "../questions.ts";

const TF = ["Vrai", "Faux"];

/**
 * Starter pack for the "Classique — famille / amis / école" theme. ~30 light,
 * non-violent questions for 7+. Target is 100 at the next milestone.
 */
const questions: Question[] = [
  { id: "cl_animals_001", type: "mcq", prompt: "Quel animal miaule ?", choices: ["Le chien", "Le chat", "La vache", "Le cheval"], answerIndex: 1, explanation: "Le chat fait « miaou ».", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_002", type: "mcq", prompt: "Quel animal vit dans l'eau et a des nageoires ?", choices: ["Le poisson", "Le lapin", "L'oiseau", "Le chat"], answerIndex: 0, explanation: "Le poisson nage avec ses nageoires.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_003", type: "true_false", prompt: "Une vache donne du lait.", choices: TF, answerIndex: 0, explanation: "La vache produit du lait.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_004", type: "mcq", prompt: "Combien de pattes a une araignée ?", choices: ["4", "6", "8", "10"], answerIndex: 2, explanation: "Une araignée a 8 pattes.", category: "Animaux", difficulty: "medium", ageMin: 7, tags: ["animaux"] },
  { id: "cl_colors_001", type: "mcq", prompt: "De quelle couleur est le ciel par beau temps ?", choices: ["Vert", "Bleu", "Rouge", "Marron"], answerIndex: 1, explanation: "Le ciel est bleu quand il fait beau.", category: "Couleurs", difficulty: "easy", ageMin: 7, tags: ["couleurs"] },
  { id: "cl_colors_002", type: "mcq", prompt: "Quelle couleur obtient-on en mélangeant le bleu et le jaune ?", choices: ["Vert", "Orange", "Violet", "Rose"], answerIndex: 0, explanation: "Bleu + jaune = vert.", category: "Couleurs", difficulty: "medium", ageMin: 7, tags: ["couleurs"] },
  { id: "cl_shapes_001", type: "mcq", prompt: "Combien de côtés a un triangle ?", choices: ["2", "3", "4", "5"], answerIndex: 1, explanation: "Un triangle a 3 côtés.", category: "Formes", difficulty: "easy", ageMin: 7, tags: ["formes"] },
  { id: "cl_shapes_002", type: "mcq", prompt: "Une forme ronde comme une roue s'appelle…", choices: ["Un carré", "Un cercle", "Un triangle", "Un rectangle"], answerIndex: 1, explanation: "Une roue a la forme d'un cercle.", category: "Formes", difficulty: "easy", ageMin: 7, tags: ["formes"] },
  { id: "cl_math_001", type: "mcq", prompt: "Combien font 2 + 3 ?", choices: ["4", "5", "6", "7"], answerIndex: 1, explanation: "2 + 3 = 5.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_002", type: "mcq", prompt: "Combien font 10 - 4 ?", choices: ["5", "6", "7", "8"], answerIndex: 1, explanation: "10 - 4 = 6.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_003", type: "mcq", prompt: "Combien font 3 × 2 ?", choices: ["5", "6", "8", "9"], answerIndex: 1, explanation: "3 × 2 = 6.", category: "Calcul", difficulty: "medium", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_004", type: "mcq", prompt: "Quel est le nombre qui vient juste après 9 ?", choices: ["8", "10", "11", "19"], answerIndex: 1, explanation: "Après 9 vient 10.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_geo_001", type: "mcq", prompt: "Dans quelle ville se trouve la tour Eiffel ?", choices: ["Londres", "Paris", "Rome", "Madrid"], answerIndex: 1, explanation: "La tour Eiffel est à Paris.", category: "Géographie", difficulty: "easy", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_002", type: "mcq", prompt: "Quelle est la grande île à l'est de l'Afrique ?", choices: ["Madagascar", "L'Australie", "Le Japon", "Cuba"], answerIndex: 0, explanation: "Madagascar est une grande île près de l'Afrique.", category: "Géographie", difficulty: "medium", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_003", type: "true_false", prompt: "La mer est faite d'eau salée.", choices: TF, answerIndex: 0, explanation: "L'eau de mer est salée.", category: "Géographie", difficulty: "easy", ageMin: 7, tags: ["geo"] },
  { id: "cl_sci_001", type: "mcq", prompt: "Quel astre nous éclaire le jour ?", choices: ["La Lune", "Le Soleil", "Une étoile filante", "Une lampe"], answerIndex: 1, explanation: "Le Soleil éclaire la journée.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["sciences"] },
  { id: "cl_sci_002", type: "mcq", prompt: "Combien de jours y a-t-il dans une semaine ?", choices: ["5", "6", "7", "8"], answerIndex: 2, explanation: "Une semaine compte 7 jours.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["temps"] },
  { id: "cl_sci_003", type: "mcq", prompt: "Quelle saison vient après l'hiver ?", choices: ["L'été", "L'automne", "Le printemps", "La pluie"], answerIndex: 2, explanation: "Après l'hiver vient le printemps.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["temps"] },
  { id: "cl_sci_004", type: "true_false", prompt: "Les plantes ont besoin d'eau pour pousser.", choices: TF, answerIndex: 0, explanation: "Les plantes boivent de l'eau pour grandir.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["sciences"] },
  { id: "cl_logic_001", type: "mcq", prompt: "Quel objet sert à écrire ?", choices: ["Une cuillère", "Un crayon", "Une chaussure", "Une assiette"], answerIndex: 1, explanation: "On écrit avec un crayon.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_002", type: "mcq", prompt: "Lequel n'est PAS un fruit ?", choices: ["La pomme", "La banane", "La carotte", "La fraise"], answerIndex: 2, explanation: "La carotte est un légume.", category: "Logique", difficulty: "medium", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_003", type: "mcq", prompt: "Que met-on aux pieds pour marcher dehors ?", choices: ["Des gants", "Des chaussures", "Un chapeau", "Une écharpe"], answerIndex: 1, explanation: "On met des chaussures aux pieds.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_fr_001", type: "mcq", prompt: "Quel mot est le contraire de « grand » ?", choices: ["Petit", "Gros", "Haut", "Long"], answerIndex: 0, explanation: "Le contraire de grand est petit.", category: "Français", difficulty: "easy", ageMin: 7, tags: ["francais"] },
  { id: "cl_fr_002", type: "mcq", prompt: "Combien y a-t-il de voyelles dans le mot « école » ?", choices: ["1", "2", "3", "4"], answerIndex: 2, explanation: "é, o, e → 3 voyelles.", category: "Français", difficulty: "medium", ageMin: 7, tags: ["francais"] },
  { id: "cl_en_001", type: "mcq", prompt: "Comment dit-on « chat » en anglais ?", choices: ["Dog", "Cat", "Bird", "Fish"], answerIndex: 1, explanation: "« Chat » se dit « cat ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_002", type: "mcq", prompt: "Que veut dire « hello » en français ?", choices: ["Au revoir", "Merci", "Bonjour", "Pardon"], answerIndex: 2, explanation: "« Hello » veut dire « bonjour ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_003", type: "mcq", prompt: "Quelle est la couleur « red » en français ?", choices: ["Bleu", "Vert", "Rouge", "Jaune"], answerIndex: 2, explanation: "« Red » veut dire « rouge ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_gen_001", type: "mcq", prompt: "Où range-t-on les livres à l'école ?", choices: ["Au réfectoire", "À la bibliothèque", "Dans la cour", "Au gymnase"], answerIndex: 1, explanation: "Les livres sont à la bibliothèque.", category: "École", difficulty: "easy", ageMin: 7, tags: ["ecole"] },
  { id: "cl_gen_002", type: "mcq", prompt: "Qui aide les élèves à apprendre en classe ?", choices: ["Le facteur", "Le maître ou la maîtresse", "Le boulanger", "Le pompier"], answerIndex: 1, explanation: "C'est l'enseignant(e) qui aide à apprendre.", category: "École", difficulty: "easy", ageMin: 7, tags: ["ecole"] },
  { id: "cl_gen_003", type: "true_false", prompt: "Un arc-en-ciel apparaît parfois après la pluie.", choices: TF, answerIndex: 0, explanation: "L'arc-en-ciel se forme avec le soleil et la pluie.", category: "Nature", difficulty: "easy", ageMin: 7, tags: ["nature"] },
  { id: "cl_gen_004", type: "mcq", prompt: "Combien de doigts a-t-on sur une main ?", choices: ["3", "4", "5", "6"], answerIndex: 2, explanation: "Une main a 5 doigts.", category: "Corps", difficulty: "easy", ageMin: 7, tags: ["corps"] },

  // ── Animaux ──
  { id: "cl_animals_005", type: "mcq", prompt: "Quel animal a une longue trompe ?", choices: ["Le lion", "L'éléphant", "Le zèbre", "Le singe"], answerIndex: 1, explanation: "L'éléphant a une longue trompe.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_006", type: "mcq", prompt: "Quel animal fait « cot cot » et pond des œufs ?", choices: ["La poule", "Le chien", "Le chat", "Le cheval"], answerIndex: 0, explanation: "La poule pond des œufs.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_007", type: "mcq", prompt: "Quel animal saute et fait « coâ coâ » ?", choices: ["La grenouille", "Le poisson", "Le lapin", "La souris"], answerIndex: 0, explanation: "La grenouille fait « coâ ».", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_008", type: "mcq", prompt: "Le bébé du chien s'appelle…", choices: ["Le chaton", "Le chiot", "Le poulain", "L'agneau"], answerIndex: 1, explanation: "Le bébé chien est un chiot.", category: "Animaux", difficulty: "medium", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_009", type: "mcq", prompt: "Quel animal porte sa maison sur le dos ?", choices: ["La tortue", "Le lièvre", "Le chat", "Le loup"], answerIndex: 0, explanation: "La tortue a une carapace.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_010", type: "mcq", prompt: "Quel oiseau court très vite mais ne vole pas ?", choices: ["L'autruche", "Le moineau", "L'aigle", "Le pigeon"], answerIndex: 0, explanation: "L'autruche court mais ne vole pas.", category: "Animaux", difficulty: "medium", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_011", type: "mcq", prompt: "Quel animal fabrique le miel ?", choices: ["La fourmi", "L'abeille", "La mouche", "Le papillon"], answerIndex: 1, explanation: "Les abeilles font le miel.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_012", type: "mcq", prompt: "On appelle souvent le lion le roi des…", choices: ["fleurs", "animaux", "voitures", "maisons"], answerIndex: 1, explanation: "Le lion est le « roi des animaux ».", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_013", type: "mcq", prompt: "Quel animal a un très long cou ?", choices: ["La girafe", "Le mouton", "Le cochon", "Le canard"], answerIndex: 0, explanation: "La girafe a un long cou.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },

  // ── Couleurs & formes ──
  { id: "cl_colors_003", type: "mcq", prompt: "De quelle couleur est une banane bien mûre ?", choices: ["Bleue", "Jaune", "Violette", "Noire"], answerIndex: 1, explanation: "Une banane mûre est jaune.", category: "Couleurs", difficulty: "easy", ageMin: 7, tags: ["couleurs"] },
  { id: "cl_colors_004", type: "mcq", prompt: "Quelle couleur obtient-on en mélangeant rouge et jaune ?", choices: ["Vert", "Orange", "Bleu", "Rose"], answerIndex: 1, explanation: "Rouge + jaune = orange.", category: "Couleurs", difficulty: "medium", ageMin: 7, tags: ["couleurs"] },
  { id: "cl_colors_005", type: "mcq", prompt: "De quelle couleur est la neige ?", choices: ["Blanche", "Verte", "Rouge", "Bleue"], answerIndex: 0, explanation: "La neige est blanche.", category: "Couleurs", difficulty: "easy", ageMin: 7, tags: ["couleurs"] },
  { id: "cl_shapes_003", type: "mcq", prompt: "Combien de côtés a un carré ?", choices: ["3", "4", "5", "6"], answerIndex: 1, explanation: "Un carré a 4 côtés égaux.", category: "Formes", difficulty: "easy", ageMin: 7, tags: ["formes"] },
  { id: "cl_shapes_004", type: "mcq", prompt: "Une forme à 3 côtés s'appelle un…", choices: ["carré", "cercle", "triangle", "rectangle"], answerIndex: 2, explanation: "3 côtés = un triangle.", category: "Formes", difficulty: "easy", ageMin: 7, tags: ["formes"] },
  { id: "cl_shapes_005", type: "mcq", prompt: "Quelle forme a un ballon de foot vu de loin ?", choices: ["Un carré", "Un rond", "Un triangle", "Une étoile"], answerIndex: 1, explanation: "Un ballon paraît rond.", category: "Formes", difficulty: "easy", ageMin: 7, tags: ["formes"] },

  // ── Calcul ──
  { id: "cl_math_005", type: "mcq", prompt: "Combien font 5 + 5 ?", choices: ["9", "10", "11", "12"], answerIndex: 1, explanation: "5 + 5 = 10.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_006", type: "mcq", prompt: "Combien font 7 - 3 ?", choices: ["3", "4", "5", "6"], answerIndex: 1, explanation: "7 - 3 = 4.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_007", type: "mcq", prompt: "Combien font 2 × 5 ?", choices: ["7", "10", "12", "15"], answerIndex: 1, explanation: "2 × 5 = 10.", category: "Calcul", difficulty: "medium", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_008", type: "mcq", prompt: "Combien font 4 + 4 ?", choices: ["6", "7", "8", "9"], answerIndex: 2, explanation: "4 + 4 = 8.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_009", type: "mcq", prompt: "Quel est le double de 3 ?", choices: ["5", "6", "7", "9"], answerIndex: 1, explanation: "Le double de 3 est 6.", category: "Calcul", difficulty: "medium", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_010", type: "mcq", prompt: "Combien font 10 + 10 ?", choices: ["15", "20", "25", "30"], answerIndex: 1, explanation: "10 + 10 = 20.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_011", type: "mcq", prompt: "Combien font 6 - 6 ?", choices: ["0", "1", "6", "12"], answerIndex: 0, explanation: "6 - 6 = 0.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_012", type: "mcq", prompt: "Quelle est la moitié de 10 ?", choices: ["2", "5", "8", "10"], answerIndex: 1, explanation: "La moitié de 10 est 5.", category: "Calcul", difficulty: "medium", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_013", type: "mcq", prompt: "Combien y a-t-il d'objets dans une paire ?", choices: ["1", "2", "3", "4"], answerIndex: 1, explanation: "Une paire = 2.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },

  // ── Géographie ──
  { id: "cl_geo_004", type: "mcq", prompt: "Quelle est la capitale de la France ?", choices: ["Lyon", "Paris", "Marseille", "Nice"], answerIndex: 1, explanation: "La capitale de la France est Paris.", category: "Géographie", difficulty: "easy", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_005", type: "mcq", prompt: "Dans quel pays se trouve la ville d'Antananarivo ?", choices: ["Madagascar", "France", "Canada", "Brésil"], answerIndex: 0, explanation: "Antananarivo est la capitale de Madagascar.", category: "Géographie", difficulty: "medium", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_006", type: "mcq", prompt: "Sur quelle planète vivons-nous ?", choices: ["Mars", "La Terre", "La Lune", "Jupiter"], answerIndex: 1, explanation: "Nous vivons sur la Terre.", category: "Géographie", difficulty: "easy", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_007", type: "mcq", prompt: "Qu'est-ce qui est le plus grand ?", choices: ["Une maison", "Une rue", "Une ville", "Une chambre"], answerIndex: 2, explanation: "Une ville est la plus grande.", category: "Géographie", difficulty: "easy", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_008", type: "mcq", prompt: "Qu'est-ce qui est le plus grand : un lac ou un océan ?", choices: ["Le lac", "L'océan", "Ils sont pareils", "Aucun des deux"], answerIndex: 1, explanation: "L'océan est bien plus grand.", category: "Géographie", difficulty: "medium", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_009", type: "true_false", prompt: "L'eau d'une rivière est de l'eau douce (pas salée).", choices: TF, answerIndex: 0, explanation: "L'eau des rivières est douce.", category: "Géographie", difficulty: "medium", ageMin: 7, tags: ["geo"] },

  // ── Sciences & nature ──
  { id: "cl_sci_005", type: "mcq", prompt: "Combien de saisons y a-t-il dans une année ?", choices: ["2", "3", "4", "5"], answerIndex: 2, explanation: "Printemps, été, automne, hiver : 4 saisons.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["temps"] },
  { id: "cl_sci_006", type: "mcq", prompt: "Le matin, le soleil se…", choices: ["couche", "lève", "cache toute la journée", "éteint"], answerIndex: 1, explanation: "Le soleil se lève le matin.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["sciences"] },
  { id: "cl_sci_007", type: "mcq", prompt: "Quand de l'eau tombe du ciel, on dit qu'il…", choices: ["neige", "pleut", "vente", "gèle"], answerIndex: 1, explanation: "L'eau qui tombe, c'est la pluie.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["nature"] },
  { id: "cl_sci_008", type: "mcq", prompt: "La glace, c'est de l'eau très…", choices: ["chaude", "froide", "sucrée", "salée"], answerIndex: 1, explanation: "La glace, c'est de l'eau gelée (froide).", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["sciences"] },
  { id: "cl_sci_009", type: "mcq", prompt: "Combien de mois y a-t-il dans une année ?", choices: ["10", "11", "12", "13"], answerIndex: 2, explanation: "Une année compte 12 mois.", category: "Sciences", difficulty: "medium", ageMin: 7, tags: ["temps"] },
  { id: "cl_sci_010", type: "mcq", prompt: "Quel astre brille dans le ciel la nuit ?", choices: ["Le soleil", "La Lune", "Une fleur", "Une voiture"], answerIndex: 1, explanation: "La Lune brille la nuit.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["sciences"] },
  { id: "cl_sci_011", type: "mcq", prompt: "Avec quelle partie du corps voit-on ?", choices: ["Les yeux", "Les oreilles", "Le nez", "Les mains"], answerIndex: 0, explanation: "On voit avec les yeux.", category: "Corps", difficulty: "easy", ageMin: 7, tags: ["corps"] },
  { id: "cl_sci_012", type: "mcq", prompt: "Avec quoi entend-on les sons ?", choices: ["Le nez", "Les oreilles", "La bouche", "Les pieds"], answerIndex: 1, explanation: "On entend avec les oreilles.", category: "Corps", difficulty: "easy", ageMin: 7, tags: ["corps"] },
  { id: "cl_sci_013", type: "mcq", prompt: "D'où vient le lait qu'on boit le matin ?", choices: ["De la vache", "Du poulet", "Du poisson", "De l'abeille"], answerIndex: 0, explanation: "Le lait vient surtout de la vache.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["nature"] },
  { id: "cl_sci_014", type: "mcq", prompt: "Quel insecte a de jolies ailes colorées ?", choices: ["Le papillon", "L'araignée", "Le ver", "La fourmi"], answerIndex: 0, explanation: "Le papillon a des ailes colorées.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["nature"] },

  // ── Logique & quotidien ──
  { id: "cl_logic_004", type: "mcq", prompt: "Avec quoi se brosse-t-on les dents ?", choices: ["Une fourchette", "Une brosse à dents", "Un crayon", "Une balle"], answerIndex: 1, explanation: "On utilise une brosse à dents.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_005", type: "mcq", prompt: "Où dort-on la nuit ?", choices: ["Dans un lit", "Dans la cuisine", "Dans la voiture", "Sur le toit"], answerIndex: 0, explanation: "On dort dans un lit.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_006", type: "mcq", prompt: "Lequel n'est PAS un animal ?", choices: ["Le chat", "La table", "Le chien", "L'oiseau"], answerIndex: 1, explanation: "Une table n'est pas un animal.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_007", type: "mcq", prompt: "Que met-on pour ne pas avoir froid en hiver ?", choices: ["Un manteau", "Un maillot de bain", "Des lunettes de soleil", "Rien du tout"], answerIndex: 0, explanation: "On met un manteau quand il fait froid.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_008", type: "mcq", prompt: "Avec quoi coupe-t-on du papier ?", choices: ["Une cuillère", "Des ciseaux", "Une gomme", "Un verre"], answerIndex: 1, explanation: "On coupe avec des ciseaux.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_009", type: "mcq", prompt: "Quel objet donne l'heure ?", choices: ["Une horloge", "Un ballon", "Une chaussure", "Un livre"], answerIndex: 0, explanation: "L'horloge donne l'heure.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_010", type: "mcq", prompt: "Où achète-t-on le pain ?", choices: ["À la boulangerie", "À la pharmacie", "À la banque", "Au garage"], answerIndex: 0, explanation: "Le pain s'achète à la boulangerie.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_011", type: "mcq", prompt: "Lequel est un fruit ?", choices: ["La pomme", "La pomme de terre", "Le poireau", "L'oignon"], answerIndex: 0, explanation: "La pomme est un fruit.", category: "Logique", difficulty: "medium", ageMin: 7, tags: ["logique"] },

  // ── Français ──
  { id: "cl_fr_003", type: "mcq", prompt: "Quel est le contraire de « chaud » ?", choices: ["Froid", "Tiède", "Brûlant", "Doux"], answerIndex: 0, explanation: "Le contraire de chaud est froid.", category: "Français", difficulty: "easy", ageMin: 7, tags: ["francais"] },
  { id: "cl_fr_004", type: "mcq", prompt: "Quel est le contraire de « jour » ?", choices: ["Soir", "Nuit", "Matin", "Midi"], answerIndex: 1, explanation: "Le contraire de jour est nuit.", category: "Français", difficulty: "easy", ageMin: 7, tags: ["francais"] },
  { id: "cl_fr_005", type: "mcq", prompt: "Combien de lettres dans le mot « chat » ?", choices: ["3", "4", "5", "6"], answerIndex: 1, explanation: "c-h-a-t : 4 lettres.", category: "Français", difficulty: "easy", ageMin: 7, tags: ["francais"] },
  { id: "cl_fr_006", type: "mcq", prompt: "Quel mot commence par la lettre A ?", choices: ["Banane", "Avion", "Chat", "Dé"], answerIndex: 1, explanation: "« Avion » commence par A.", category: "Français", difficulty: "easy", ageMin: 7, tags: ["francais"] },
  { id: "cl_fr_007", type: "mcq", prompt: "Quel est le pluriel de « un chat » ?", choices: ["des chat", "des chats", "un chats", "le chat"], answerIndex: 1, explanation: "Au pluriel : des chats.", category: "Français", difficulty: "medium", ageMin: 7, tags: ["francais"] },
  { id: "cl_fr_008", type: "mcq", prompt: "Quel est le contraire de « monter » ?", choices: ["descendre", "courir", "sauter", "tomber"], answerIndex: 0, explanation: "Le contraire de monter est descendre.", category: "Français", difficulty: "medium", ageMin: 7, tags: ["francais"] },

  // ── Anglais débutant ──
  { id: "cl_en_004", type: "mcq", prompt: "Comment dit-on « chien » en anglais ?", choices: ["Cat", "Dog", "Cow", "Pig"], answerIndex: 1, explanation: "« Chien » se dit « dog ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_005", type: "mcq", prompt: "Que veut dire « blue » ?", choices: ["Rouge", "Bleu", "Vert", "Jaune"], answerIndex: 1, explanation: "« Blue » veut dire bleu.", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_006", type: "mcq", prompt: "Comment dit-on « merci » en anglais ?", choices: ["Please", "Sorry", "Thank you", "Hello"], answerIndex: 2, explanation: "« Merci » se dit « thank you ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_007", type: "mcq", prompt: "Que veut dire « one, two, three » ?", choices: ["un, deux, trois", "rouge, vert, bleu", "lundi, mardi", "chat, chien"], answerIndex: 0, explanation: "« One two three » = un, deux, trois.", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_008", type: "mcq", prompt: "Comment dit-on « maison » en anglais ?", choices: ["House", "Car", "Tree", "Book"], answerIndex: 0, explanation: "« Maison » se dit « house ».", category: "Anglais", difficulty: "medium", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_009", type: "mcq", prompt: "Que veut dire « yes » ?", choices: ["Non", "Oui", "Peut-être", "Stop"], answerIndex: 1, explanation: "« Yes » veut dire oui.", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },

  // ── Corps & vie quotidienne ──
  { id: "cl_body_001", type: "mcq", prompt: "Combien d'yeux avons-nous ?", choices: ["1", "2", "3", "4"], answerIndex: 1, explanation: "Nous avons 2 yeux.", category: "Corps", difficulty: "easy", ageMin: 7, tags: ["corps"] },
  { id: "cl_body_002", type: "mcq", prompt: "Avec quoi marche-t-on ?", choices: ["Les mains", "Les pieds", "Les oreilles", "Le nez"], answerIndex: 1, explanation: "On marche avec les pieds.", category: "Corps", difficulty: "easy", ageMin: 7, tags: ["corps"] },
  { id: "cl_daily_001", type: "mcq", prompt: "Quel repas mange-t-on le matin ?", choices: ["Le dîner", "Le petit-déjeuner", "Le goûter", "Le souper"], answerIndex: 1, explanation: "Le matin, c'est le petit-déjeuner.", category: "Quotidien", difficulty: "easy", ageMin: 7, tags: ["quotidien"] },
  { id: "cl_daily_002", type: "mcq", prompt: "Où range-t-on les vêtements ?", choices: ["Dans l'armoire", "Dans le frigo", "Dans le four", "Dans la baignoire"], answerIndex: 0, explanation: "Les vêtements vont dans l'armoire.", category: "Quotidien", difficulty: "easy", ageMin: 7, tags: ["quotidien"] },
  { id: "cl_daily_003", type: "mcq", prompt: "Avec quoi vole-t-on dans le ciel ?", choices: ["Un avion", "Un bateau", "Un vélo", "Un train"], answerIndex: 0, explanation: "L'avion vole dans le ciel.", category: "Quotidien", difficulty: "easy", ageMin: 7, tags: ["quotidien"] },
  { id: "cl_daily_004", type: "mcq", prompt: "Sur quoi roule une voiture ?", choices: ["Des roues", "Des ailes", "Des pattes", "Des nageoires"], answerIndex: 0, explanation: "Une voiture roule sur des roues.", category: "Quotidien", difficulty: "easy", ageMin: 7, tags: ["quotidien"] },
  { id: "cl_animals_014", type: "mcq", prompt: "Quel animal aboie ?", choices: ["Le chat", "Le chien", "Le mouton", "La poule"], answerIndex: 1, explanation: "Le chien aboie : « ouaf ! »", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_math_014", type: "mcq", prompt: "Combien font 3 + 6 ?", choices: ["8", "9", "10", "11"], answerIndex: 1, explanation: "3 + 6 = 9.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_nat_001", type: "true_false", prompt: "Le feu, c'est chaud.", choices: TF, answerIndex: 0, explanation: "Le feu est très chaud — on fait attention !", category: "Nature", difficulty: "easy", ageMin: 7, tags: ["nature"] },
];

export const classicFamilySchool: ThemePack = {
  id: "classic-family-school",
  name: "Classique",
  description: "Questions simples pour jouer en famille, entre amis ou à l'école.",
  minAge: 7,
  visualStyle: "classic",
  questions,
};
