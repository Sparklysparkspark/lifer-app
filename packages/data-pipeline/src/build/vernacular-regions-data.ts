// Compiled from a worldwide research pass (see ~/.claude/plans — Aug 2026 session) into which
// countries' fine-grained admin-1 provinces are too unfamiliar/granular for browsing, and what
// real, commonly-known grouping locals/travelers actually use instead (never invented). Every
// province name below must match the exact string stored in `regions.name` for that country —
// copied verbatim from the research, diacritics and all, since apply-vernacular-regions.ts
// matches by exact string.
//
// - "no_grouping": the country's own provinces/states are already the familiar browsing unit
//   (Canada, India, Nigeria, etc.) — left untouched.
// - "grouping": groups map a real region name to its member province names. Any province not
//   listed in ANY group for a "grouping" country is left as a direct, ungrouped child (some
//   countries only have a real name for PART of their provinces — e.g. Sudan's Darfur/Kordofan
//   — forcing every leftover into an invented bucket would be worse than leaving them alone).
// - disconnects: provinces that are ecologically/geographically isolated destinations in their
//   own right (the Galápagos pattern) — reparented to the country's own parent (its continent),
//   never folded into a mainland group, regardless of the country's overall verdict.
export interface CountryGrouping {
  verdict: "grouping" | "no_grouping";
  groups?: Record<string, string[]>;
  disconnects?: string[];
}

export const VERNACULAR_GROUPINGS: Record<string, CountryGrouping> = {
  // ---- Original research pass ----
  "United Kingdom": {
    verdict: "grouping",
    groups: {
      "Northern Ireland": ["Antrim","Ards","Armagh","Ballymena","Ballymoney","Banbridge","Belfast","Carrickfergus","Castlereagh","Coleraine","Craigavon","Derry","Down","Dungannon","Fermanagh","Larne","Limavady","Lisburn","Magherafelt","Mid Ulster","Moyle","Newry and Mourne","Newtownabbey","North Down","Omagh","Strabane"],
      "Scotland": ["Aberdeen","Aberdeenshire","Angus","Argyll and Bute","Clackmannanshire","Dumfries and Galloway","Dundee","East Ayrshire","East Dunbartonshire","East Lothian","East Renfrewshire","Edinburgh","Eilean Siar","Falkirk","Fife","Glasgow","Highland","Inverclyde","Midlothian","Moray","North Ayshire","North Lanarkshire","Orkney","Perthshire and Kinross","Renfrewshire","Scottish Borders","Shetland Islands","South Ayrshire","South Lanarkshire","Stirling","West Dunbartonshire","West Lothian"],
      "Wales": ["Anglesey","Blaenau Gwent","Bridgend","Caerphilly","Cardiff","Carmarthenshire","Ceredigion","Conwy","Denbighshire","Flintshire","Gwynedd","Merthyr Tydfil","Monmouthshire","Neath Port Talbot","Newport","Pembrokeshire","Powys","Rhondda, Cynon, Taff","Swansea","Torfaen","Vale of Glamorgan","Wrexham"],
      "England - North East": ["Darlington","Durham","Gateshead","Hartlepool","Middlesbrough","Newcastle upon Tyne","North Tyneside","Northumberland","Redcar and Cleveland","South Tyneside","Stockton-on-Tees","Sunderland"],
      "England - North West": ["Blackburn with Darwen","Blackpool","Bolton","Bury","Cheshire East","Cheshire West and Chester","Cumbria","Halton","Knowsley","Lancashire","Liverpool","Merseyside","Oldham","Rochdale","Salford","Sefton","Stockport","Tameside","Trafford","Warrington","Wigan"],
      "England - Yorkshire and the Humber": ["Barnsley","Bradford","Calderdale","Doncaster","East Riding of Yorkshire","Kingston upon Hull","Kirklees","Leeds","North East Lincolnshire","North Lincolnshire","North Yorkshire","Rotherham","Sheffield","Wakefield","York"],
      "England - East Midlands": ["Derby","Derbyshire","Leicester","Leicestershire","Lincolnshire","Northamptonshire","Nottingham","Nottinghamshire","Rutland"],
      "England - West Midlands": ["Birmingham","Coventry","Dudley","Herefordshire","Sandwell","Shropshire","Solihull","Staffordshire","Stoke-on-Trent","Telford and Wrekin","Walsall","Warwickshire","Wolverhampton","Worcestershire"],
      "England - East of England": ["Bedford","Cambridgeshire","Central Bedfordshire","Essex","Hertfordshire","Luton","Norfolk","Peterborough","Southend-on-Sea","Suffolk","Thurrock"],
      "England - London": ["Barking and Dagenham","Barnet","Bexley","Brent","Bromley","Camden","City","Croydon","Ealing","Enfield","Greenwich","Hackney","Hammersmith and Fulham","Haringey","Harrow","Havering","Hillingdon","Hounslow","Islington","Kensington and Chelsea","Kingston upon Thames","Lambeth","Lewisham","Merton","Newham","Redbridge","Richmond upon Thames","Southwark","Sutton","Tower Hamlets","Waltham Forest","Wandsworth","Westminster"],
      "England - South East": ["Bracknell Forest","Brighton and Hove","Buckinghamshire","East Sussex","Hampshire","Isle of Wight","Kent","Medway","Milton Keynes","Oxfordshire","Portsmouth","Reading","Royal Borough of Windsor and Maidenhead","Slough","Surrey","West Berkshire","West Sussex","Wokingham"],
      "England - South West": ["Bath and North East Somerset","Bournemouth","Bristol","Cornwall","Devon","Dorset","Gloucestershire","Isles of Scilly","North Somerset","Plymouth","Poole","Somerset","South Gloucestershire","Swindon","Torbay","Wiltshire"],
    },
  },
  "Slovenia": {
    verdict: "grouping",
    groups: {
      "Pomurska": ["Apace","Beltinci","Cankova","Dobrovnik","Gornja Radgona","Gornji Petrovci","Grad","Hodoš","Kobilje","Križevci","Kuzma","Lendava","Ljutomer","Moravske Toplice","Murska Sobota","Odranci","Puconci","Radenci","Razkrižje","Rogašovci","Turnišče","Velika Polana","Veržej","Črenšovci","Šalovci"],
      "Podravska": ["Benedikt","Cerkvenjak","Destrnik","Dornava","Duplek","Gorišnica","Hajdina","Hoce-Slivnica","Juršinci","Kidricevo","Kungota","Lenart","Lovrenc na Pohorju","Majšperk","Maribor","Markovci","Miklavž na Dravskem polju","Oplotnica","Ormož","Pesnica","Podlehnik","Ptuj","Race-Fram","Ruše","Selnica ob Dravi","Slovenska Bistrica","Starše","Sveta Ana","Sveti Andraž v Slovenskih Goricah","Trnovska vas","Videm","Zavrc","Šentilj","Žetale"],
      "Koroška": ["Dravograd","Mežica","Mislinja","Muta","Podvelka","Prevalje","Radlje ob Dravi","Ravne na Koroškem","Ribnica na Pohorju","Slovenj Gradec","Vuzenica","Črna na Koroškem"],
      "Savinjska": ["Braslovce","Celje","Dobje","Dobrna","Gornji Grad","Kozje","Laško","Ljubno","Luce","Mozirje","Nazarje","Podcetrtek","Polzela","Prebold","Rogatec","Rogaška Slatina","Slovenske Konjice","Solcava","Tabor","Velenje","Vitanje","Vojnik","Vransko","Zrece","Šentjur pri Celju","Šmarje pri Jelšah","Šmartno ob Paki","Šoštanj","Štore","Žalec"],
      // Named "Zasavska Region" rather than plain "Zasavska" — the source province list has
      // its own anomalous "Zasavska" entry (flagged by the research as likely bad upstream
      // data: the region's own name leaking into the municipality list), which would collide
      // on (name, parent_id) with a same-named group under the same country.
      "Zasavska Region": ["Hrastnik","Litija","Trbovlje","Radece"],
      "Posavska": ["Bistrica ob Sotli","Brežice","Krsko","Krško","Sevnica"],
      "Jugovzhodna Slovenija": ["Crnomelj","Dolenjske Toplice","Kocevje","Kostel","Loški Potok","Metlika","Mirna Pec","Novo Mesto","Ribnica","Semic","Sodražica","Trebnje","Šentjernej","Škocjan","Žužemberk"],
      "Primorsko-notranjska": ["Bloke","Cerknica","Ilirska Bistrica","Loška dolina","Pivka","Postojna"],
      "Osrednjeslovenska": ["Borovnica","Brezovica","Dobrepolje","Dobrova-Polhov Gradec","Dol pri Ljubljani","Domžale","Grosuplje","Horjul","Ig","Ivancna Gorica","Kamnik","Komenda","Ljubljana","Logatec","Lukovica","Medvode","Mengeš","Moravce","Trzin","Velike Lašče","Vodice","Vrhnika","Škofljica","Šmartno in Litiji"],
      "Gorenjska": ["Bled","Bohinj","Cerklje na Gorenjskem","Gorenja vas-Poljane","Jesenice","Jezersko","Kranj","Kranjska Gora","Naklo","Preddvor","Radovljica","Tržič","Šenčur","Škofja Loka","Železniki","Žiri","Žirovnica"],
      "Goriška": ["Ajdovščina","Bovec","Brda","Cerkno","Idrija","Kanal","Kobarid","Miren-Kostanjevica","Nova Goriška","Tolmin","Vipava","Šempeter-Vrtojba"],
      "Obalno-kraška": ["Divaca","Hrpelje-Kozina","Izola","Komen","Koper","Piran","Sežana"],
    },
  },
  "Latvia": {
    verdict: "grouping",
    groups: {
      "Rīga": ["Riga"],
      "Pierīga": ["Alojas","Babites","Baldones","Carnikavas","Engures","Garkalnes","Ikskiles","Incukalna","Jaunpils","Jurmala","Kandavas","Keguma","Kekavas","Krimuldas","Lielvardes","Limbaži","Malpils","Marupes","Ogre","Olaines","Ropazu","Salacgrivas","Salaspils","Saulkrastu","Sejas","Siguldas","Stopinu","Tukums","Ādaži"],
      "Vidzeme": ["Aluksne","Amatas","Apes","Beverinas","Burtnieku","Cesu","Cesvaines","Erglu","Gulbene","Jaunpiebalgas","Kocenu","Ligatnes","Lubanas","Madona","Mazsalacas","Nauksenu","Pargaujas","Priekulu","Raunas","Rujienas","Smiltenes","Strencu","Valkas","Valmiera","Varaklanu","Vecpiebalgas"],
      "Kurzeme": ["Aizputes","Alsungas","Brocenu","Dundagas","Durbes","Grobinas","Kuldigas","Liepāja","Mersraga","Nicas","Pavilostas","Priekules","Rojas","Rucavas","Saldus","Skrundas","Talsi","Vainodes","Ventspils"],
      "Zemgale": ["Aizkraukles","Aknistes","Auces","Bauska","Dobele","Iecavas","Jaunjelgavas","Jekabpils","Jelgava","Kokneses","Krustpils","Neretas","Ozolnieku","Plavinu","Rundales","Salas","Skriveru","Tervetes","Vecumnieku","Viesites"],
      "Latgale": ["Aglonas","Baltinavas","Balvu","Ciblas","Dagdas","Daugavpils","Ilukstes","Karsavas","Kraslavas","Livanu","Ludzas","Preilu","Rezekne","Rezeknes","Riebinu","Rugaju","Varkavas","Vilakas","Vilanu","Zilupes"],
    },
  },
  "Philippines": {
    verdict: "grouping",
    groups: {
      "Ilocos Region": ["Ilocos Norte","Ilocos Sur","La Union","Pangasinan","Dagupan"],
      "Cagayan Valley": ["Batanes","Cagayan","Isabela","Nueva Vizcaya","Quirino","Santiago"],
      "Central Luzon": ["Aurora","Bataan","Bulacan","Nueva Ecija","Pampanga","Tarlac","Zambales","Angeles","Olongapo"],
      "CALABARZON": ["Batangas","Cavite","Laguna","Quezon","Rizal","Lucena"],
      "MIMAROPA": ["Marinduque","Mindoro Occidental","Mindoro Oriental","Palawan","Romblon","Puerto Princesa"],
      "Bicol Region": ["Albay","Camarines Norte","Camarines Sur","Catanduanes","Masbate","Sorsogon","Naga"],
      "Western Visayas": ["Aklan","Antique","Capiz","Guimaras","Iloilo","Negros Occidental","Bacolod"],
      "Central Visayas": ["Bohol","Cebu","Negros Oriental","Siquijor","Lapu-Lapu","Mandaue"],
      "Eastern Visayas": ["Biliran","Eastern Samar","Leyte","Northern Samar","Samar","Southern Leyte","Ormoc","Tacloban"],
      "Zamboanga Peninsula": ["Zamboanga del Norte","Zamboanga del Sur","Zamboanga Sibugay","Zamboanga"],
      "Northern Mindanao": ["Bukidnon","Camiguin","Lanao del Norte","Misamis Occidental","Misamis Oriental","Cagayan de Oro","Iligan"],
      "Davao Region": ["Compostela Valley","Davao Oriental","Davao del Norte","Davao del Sur","Davao"],
      "SOCCSKSARGEN": ["Cotabato","Sarangani","South Cotabato","Sultan Kudarat","General Santos"],
      "Caraga": ["Agusan del Norte","Agusan del Sur","Surigao del Norte","Surigao del Sur","Butuan"],
      "BARMM": ["Basilan","Lanao del Sur","Maguindanao","Sulu","Tawi-Tawi"],
      "Cordillera Administrative Region": ["Abra","Apayao","Benguet","Ifugao","Kalinga","Mountain Province","Baguio"],
      "NCR/Metro Manila": ["Caloocan","Las Pinas","Makati","Malabon","Mandaluyong City","Manila","Marikina","Muntinlupa","Navotas","Paranaque","Pasay","Pasig","Pateros","Quezon City","Taguig","Valenzuela"],
    },
  },
  "Uganda": {
    verdict: "grouping",
    groups: {
      "Central": ["Buikwe","Bukomansimbi","Butambala","Buvuma","Gomba","Kalangala","Kalungu","Kampala","Kayunga","Kiboga","Kyankwanzi","Luweero","Lwengo","Lyantonde","Masaka","Mityana","Mpigi","Mubende","Mukono","Nakaseke","Nakasongola","Rakai","Sembabule","Wakiso"],
      "Eastern": ["Amuria","Budaka","Bududa","Bugiri","Bukedea","Bukwa","Bulambuli","Busia","Butaleja","Buyende","Iganga","Jinja","Kaberamaido","Kaliro","Kamuli","Kapchorwa","Katakwi","Kibuku","Kumi","Kween","Luuka","Manafwa","Mayuge","Mbale","Namayingo","Namutumba","Ngora","Pallisa","Serere","Sironko","Soroti","Tororo"],
      "Northern": ["Abim","Adjumani","Agago","Alebtong","Amolatar","Amudat","Amuru","Apac","Arua","Dokolo","Gulu","Kaabong","Kitgum","Koboko","Kole","Kotido","Lamwo","Lira","Maracha","Moroto","Moyo","Nakapiripirit","Napak","Nebbi","Nwoya","Otuke","Oyam","Pader","Yumbe","Zombo"],
      "Western": ["Buhweju","Buliisa","Bundibugyo","Bushenyi","Hoima","Ibanda","Isingiro","Kabale","Kabarole","Kamwenge","Kanungu","Kasese","Kibale","Kiryandongo","Kisoro","Kyegegwa","Kyenjojo","Masindi","Mbarara","Mitooma","Ntoroko","Ntungamo","Rubirizi","Rukungiri","Sheema"],
    },
  },
  "Italy": {
    verdict: "grouping",
    groups: {
      "Piemonte": ["Alessandria","Asti","Biella","Cuneo","Novara","Turin","Verbano-Cusio-Ossola","Vercelli"],
      "Valle d'Aosta": ["Aoste"],
      "Lombardia": ["Bergamo","Brescia","Como","Cremona","Lecco","Lodi","Mantova","Milano","Monza e Brianza","Pavia","Sondrio","Varese"],
      "Trentino-Alto Adige": ["Bozen","Trento"],
      "Veneto": ["Belluno","Padova","Rovigo","Treviso","Venezia","Verona","Vicenza"],
      "Friuli-Venezia Giulia": ["Gorizia","Pordenone","Trieste","Udine"],
      "Liguria": ["Genova","Imperia","La Spezia","Savona"],
      "Emilia-Romagna": ["Bologna","Ferrara","Forlì-Cesena","Modena","Parma","Piacenza","Ravenna","Reggio Emilia","Rimini"],
      "Toscana": ["Arezzo","Firenze","Grosseto","Livorno","Lucca","Massa-Carrara","Pisa","Pistoia","Prato","Siena"],
      "Umbria": ["Perugia","Terni"],
      "Marche": ["Ancona","Ascoli Piceno","Fermo","Macerata","Pesaro e Urbino"],
      "Lazio": ["Frosinone","Latina","Rieti","Roma","Viterbo"],
      "Abruzzo": ["Chieti","L'Aquila","Pescara","Teramo"],
      "Molise": ["Campobasso","Isernia"],
      "Campania": ["Avellino","Benevento","Caserta","Napoli","Salerno"],
      "Puglia": ["Bari","Barletta-Andria Trani","Brindisi","Foggia","Lecce","Taranto"],
      "Basilicata": ["Matera","Potenza"],
      "Calabria": ["Catanzaro","Cosenza","Crotene","Reggio Calabria","Vibo Valentia"],
      "Sicilia": ["Agrigento","Caltanissetta","Catania","Enna","Messina","Palermo","Ragusa","Siracusa","Trapani"],
      "Sardegna": ["Cagliari","Carbonia-Iglesias","Medio Campidano","Nuoro","Ogliastra","Olbia-Tempio","Oristrano","Sassari"],
    },
  },
  "France": {
    verdict: "grouping",
    groups: {
      "Auvergne-Rhône-Alpes": ["Ain","Allier","Ardèche","Cantal","Drôme","Isère","Loire","Haute-Loire","Puy-de-Dôme","Rhône","Savoie","Haute-Savoie"],
      "Bourgogne-Franche-Comté": ["Côte-d'Or","Doubs","Jura","Nièvre","Haute-Saône","Saône-et-Loire","Yonne","Territoire de Belfort"],
      "Bretagne": ["Côtes-d'Armor","Finistère","Ille-et-Vilaine","Morbihan"],
      "Centre-Val de Loire": ["Cher","Eure-et-Loir","Indre","Indre-et-Loire","Loir-et-Cher","Loiret"],
      "Corse": ["Corse-du-Sud","Haute-Corse"],
      "Grand Est": ["Ardennes","Aube","Marne","Haute-Marne","Meurthe-et-Moselle","Meuse","Moselle","Bas-Rhin","Haute-Rhin","Vosges"],
      "Hauts-de-France": ["Aisne","Nord","Oise","Pas-de-Calais","Somme"],
      "Île-de-France": ["Essonne","Hauts-de-Seine","Paris","Seien-et-Marne","Seine-Saint-Denis","Val-d'Oise","Val-de-Marne","Yvelines"],
      "Normandie": ["Calvados","Eure","Manche","Orne","Seine-Maritime"],
      "Nouvelle-Aquitaine": ["Charente","Charente-Maritime","Corrèze","Creuse","Dordogne","Gironde","Landes","Lot-et-Garonne","Pyrénées-Atlantiques","Deux-Sèvres","Vienne","Haute-Vienne"],
      "Occitanie": ["Ariège","Aude","Aveyron","Gard","Haute-Garonne","Gers","Hérault","Lot","Lozère","Hautes-Pyrénées","Pyrénées-Orientales","Tarn","Tarn-et-Garonne"],
      "Pays de la Loire": ["Loire-Atlantique","Maine-et-Loire","Mayenne","Sarthe","Vendée"],
      "Provence-Alpes-Côte d'Azur": ["Alpes-de-Haute-Provence","Hautes-Alpes","Alpes-Maritimes","Bouches-du-Rhône","Var","Vaucluse"],
    },
    disconnects: ["Guadeloupe", "Guyane française", "La Réunion", "Martinique", "Mayotte"],
  },
  "Russia": {
    verdict: "grouping",
    groups: {
      "Central": ["Belgorod","Bryansk","Ivanovo","Kaluga","Kostroma","Kursk","Lipetsk","Moskovskaya","Moskva","Orel","Ryazan'","Smolensk","Tambov","Tver'","Tula","Voronezh","Vladimir","Yaroslavl'"],
      "Northwestern": ["Arkhangel'sk","Vologda","Kaliningrad","Karelia","Komi","Leningrad","Murmansk","Nenets","Novgorod","Pskov","City of St. Petersburg"],
      "Southern": ["Adygey","Astrakhan'","Volgograd","Kalmyk","Krasnodar","Rostov","Crimea","Sevastopol"],
      "North Caucasian": ["Chechnya","Dagestan","Ingush","Kabardin-Balkar","Karachay-Cherkess","North Ossetia","Stavropol'"],
      "Volga": ["Bashkortostan","Kirov","Mariy-El","Mordovia","Nizhegorod","Orenburg","Penza","Perm'","Samara","Saratov","Tatarstan","Udmurt","Ul'yanovsk","Chuvash"],
      "Ural": ["Kurgan","Sverdlovsk","Tyumen'","Chelyabinsk","Khanty-Mansiy","Yamal-Nenets"],
      "Siberian": ["Altay","Buryat","Chita","Gorno-Altay","Irkutsk","Kemerovo","Khakass","Krasnoyarsk","Novosibirsk","Omsk","Tomsk","Tuva","Maga Buryatdan"],
      "Far Eastern": ["Amur","Chukchi Autonomous Okrug","Kamchatka","Khabarovsk","Primor'ye","Sakha (Yakutia)","Sakhalin","Yevrey"],
    },
  },
  "North Macedonia": {
    verdict: "grouping",
    groups: {
      "Vardar": ["Čaška","Demir Kapija","Gradsko","Kavadartsi","Lozovo","Negotino","Rosoman","Sveti Nikole","Veles"],
      "East": ["Berovo","Češinovo-Obleševo","Delčevo","Karbinci","Kočani","Makedonska Kamenica","Pehčevo","Probištip","Štip","Vinica","Zrnovci"],
      "Southwest": ["Brod","Centar župa","Debar","Debarca","Drugovo","Kičevo","Ohrid","Oslomej","Plasnica","Struga","Vevčani","Vraneštica","Zajas"],
      "Southeast": ["Bogdanci","Bosilovo","Dojran","Gevgelija","Konče","Novo Selo","Radoviš","Strumitsa","Valandovo","Vasilevo"],
      "Pelagonia": ["Bitola","Demir Hisar","Dolneni","Krivogaštani","Kruševo","Mogila","Novaci","Prilep","Resen"],
      "Polog": ["Bogovinje","Brvenica","Gostivar","Jegunovce","Mavrovo and Rostusa","Tearce","Tetovo","Vrapcište","Želino"],
      "Northeast": ["Kratovo","Kriva Palanka","Kumanovo","Lipkovo","Rankovce","Staro Nagoričane"],
      "Skopje": ["Aerodrom","Aračinovo","Butel","Centar","Čair","Čučer Sandevo","Gazi Baba","Gjorče Petrov","Ilinden","Karpoš","Kisela Voda","Saraj","Skopje","Sopište","Studeničani","Šuto Orizari","Zelenikovo"],
    },
  },
  "Turkey": {
    verdict: "grouping",
    groups: {
      "Marmara": ["Istanbul","Kocaeli","Sakarya","Yalova","Bursa","Bilecik","Balikesir","Çanakkale","Tekirdag","Kirklareli","Edirne"],
      "Aegean": ["Izmir","Manisa","Aydin","Denizli","Mugla","Kütahya","Usak","Afyonkarahisar"],
      "Mediterranean": ["Antalya","Isparta","Burdur","Mersin","Adana","Hatay","Osmaniye","K. Maras"],
      "Central Anatolia": ["Ankara","Aksaray","Çankiri","Eskisehir","Karaman","Kayseri","Kinkkale","Kirsehir","Konya","Nevsehir","Nigde","Sivas","Yozgat"],
      "Black Sea": ["Amasya","Artvin","Bartın","Bayburt","Bolu","Çorum","Düzce","Giresun","Gümüshane","Karabük","Kastamonu","Ordu","Rize","Samsun","Sinop","Tokat","Trabzon","Zinguldak"],
      "Eastern Anatolia": ["Agri","Ardahan","Bingöl","Bitlis","Elazig","Erzincan","Erzurum","Hakkari","Iğdir","Kars","Malatya","Mus","Tunceli","Van"],
      "Southeastern Anatolia": ["Adiyaman","Batman","Diyarbakir","Gaziantep","Kilis","Mardin","Siirt","Sanliurfa","Sirnak"],
    },
  },
  "Thailand": {
    verdict: "grouping",
    groups: {
      "North": ["Chiang Mai","Chiang Rai","Lampang","Lamphun","Mae Hong Son","Nan","Phayao","Phrae","Uttaradit"],
      "Northeast": ["Amnat Charoen","Bueng Kan","Buri Ram","Chaiyaphum","Kalasin","Khon Kaen","Loei","Maha Sarakham","Mukdahan","Nakhon Phanom","Nakhon Ratchasima","Nong Bua Lam Phu","Nong Khai","Roi Et","Sakon Nakhon","Si Sa Ket","Surin","Ubon Ratchathani","Udon Thani","Yasothon"],
      "Central": ["Ang Thong","Bangkok Metropolis","Chai Nat","Kamphaeng Phet","Lop Buri","Nakhon Pathom","Nakhon Sawan","Nonthaburi","Pathum Thani","Phetchabun","Phichit","Phitsanulok","Phra Nakhon Si Ayutthaya","Samut Prakan","Samut Sakhon","Samut Songkhram","Saraburi","Sing Buri","Sukhothai","Suphan Buri","Uthai Thani"],
      "East": ["Chachoengsao","Chanthaburi","Chon Buri","Nakhon Nayok","Prachin Buri","Rayong","Sa Kaeo","Trat"],
      "West": ["Kanchanaburi","Phetchaburi","Prachuap Khiri Khan","Ratchaburi","Tak"],
      "South": ["Chumphon","Krabi","Nakhon Si Thammarat","Narathiwat","Pattani","Phangnga","Phatthalung","Phuket","Ranong","Satun","Songkhla","Surat Thani","Trang","Yala"],
    },
  },
  "Azerbaijan": {
    verdict: "grouping",
    groups: {
      "Baku": ["Bakı"],
      "Absheron-Khizi": ["Abşeron","Xizı","Sumqayıt"],
      "Ganja-Dashkasan": ["Ağstafa","Daşkəsən","Gədəbəy","Gəncə","Goranboy","Naftalan","Qazax","Samux","Şəmkir","Tovuz","Xanlar"],
      "Shaki-Zagatala": ["Balakən","Oğuz","Qax","Qəbələ","Zaqatala","Şəki"],
      "Lankaran": ["Astara","Cəlilabad","Lankaran","Lerik","Masallı","Yardımlı"],
      "Guba-Khachmaz": ["Dəvəçi","Quba","Qusar","Siyəzən","Xaçmaz"],
      "Nakhchivan Autonomous Republic": ["Babək","Culfa","Kangarli","Naxçıvan","Ordubad","Sədərək","Şahbuz","Şərur"],
      "Karabakh": ["Ağcabədi","Ağdam","Bərdə","Cəbrayıl","Füzuli","Kəlbəcər","Qubadli","Stepanakert","Tərtər","Xocalı","Xocavənd","Zəngilan","Şuşa"],
      "Central Aran": ["Ağdaş","Beyləqan","Biləsuvar","Göyçay","Hajigabul","Kürdəmir","Mingəçevir","Neftçala","Saatlı","Sabirabad","Salyan","Shirvan","Ucar","Zərdab","İmişli","Yevlakh","Yevlakh Rayon"],
      "Mountainous Shirvan": ["Ağsu","Qobustan","İsmayıllı"],
    },
  },
  "Malta": {
    verdict: "grouping",
    groups: {
      "Malta": ["Attard","Balzan","Birgu","Birkirkara","Birżebbuġa","Cospicua","Dingli","Fgura","Floriana","Gudja","Għargħur","Gżira","Iklin","Isla","Kalkara","Kirkop","Lija","Luqa","Marsa","Marsaskala","Marsaxlokk","Mdina","Mellieħa","Mosta","Mqabba","Msida","Mtarfa","Mġarr","Naxxar","Paola","Pietà","Qormi","Qrendi","Rabat","Safi","San Giljan","San Pawl il-Bahar","San Ġwann","Santa Luċija","Santa Venera","Siġġiewi","Sliema","Swieqi","Ta' Xbiex","Tarxien","Valletta","Xgħajra","Ħamrun","Żabbar","Żejtun","Żurrieq"],
      "Gozo and Comino": ["Fontana","Gozo","Għajnsielem","Għarb","Għasri","Kerċem","Munxar","Nadur","Qala","San Lawrenz","Sannat","Xagħra","Xewkija","Żebbuġ"],
    },
  },
  "Vietnam": {
    verdict: "grouping",
    groups: {
      "Northwest": ["Lai Chau","Son La","Điện Biên","Hòa Bình"],
      "Northeast": ["Bắc Giang","Cao Bằng","Hà Giang","Lào Cai","Lạng Sơn","Quảng Ninh","Thái Nguyên","Tuyên Quang","Yên Bái","Phú Thọ"],
      "Red River Delta": ["Bắc Ninh","Ha Noi","Hà Nam","Hải Dương","Hải Phòng","Nam Định","Ninh Bình","Thái Bình","Vĩnh Phúc"],
      "North Central Coast": ["Ha Tinh","Nghệ An","Quảng Bình","Quảng Trị","Thanh Hóa","Thừa Thiên - Huế"],
      "South Central Coast": ["Bình Thuận","Bình Định","Khánh Hòa","Ninh Thuận","Phú Yên","Quàng Nam","Quảng Ngãi","Đà Nẵng"],
      "Central Highlands": ["Gia Lai","Kon Tum","Lâm Đồng","Đắk Lắk","Đắk Nông"],
      "Southeast": ["Bà Rịa - Vũng Tàu","Bình Dương","Bình Phước","Hồ Chí Minh city","Tây Ninh"],
      "Mekong Delta": ["An Giang","Bạc Liêu","Bến Tre","Can Tho","Cà Mau","Hau Giang","Kiên Giang","Long An","Sóc Trăng","Tiền Giang","Trà Vinh","Vĩnh Long","Ðong Tháp"],
    },
    // "Đông Bắc", "Đông Nam Bộ", "Đồng Bằng Sông Hồng" are bad data (already region names, not
    // provinces) — deliberately left out of every group; a data-cleanup pass should remove
    // those 3 rows from `regions` entirely rather than trying to map them.
  },
  "Spain": {
    verdict: "grouping",
    groups: {
      "Andalucía": ["Almería","Cádiz","Córdoba","Huelva","Jaén","Málaga","Sevilla"],
      "Aragón": ["Huesca","Teruel","Zaragoza"],
      "Asturias": ["Asturias"],
      "Baleares": ["Baleares"],
      "Canarias": ["Las Palmas","Santa Cruz de Tenerife"],
      "Cantabria": ["Cantabria"],
      "Castilla-La Mancha": ["Albacete","Ciudad Real","Cuenca","Guadalajara","Toledo"],
      "Castilla y León": ["Burgos","Palencia","Salamanca","Segovia","Soria","Valladolid","Zamora","Ávila"],
      "Cataluña": ["Barcelona","Gerona","Lérida","Tarragona"],
      "Extremadura": ["Badajoz","Cáceres"],
      "Galicia": ["La Coruña","Lugo","Orense","Pontevedra"],
      "Madrid": ["Madrid"],
      "Murcia": ["Murcia"],
      "Navarra": ["Navarra"],
      "País Vasco": ["Bizkaia","Gipuzkoa","Álava"],
      "La Rioja": ["La Rioja"],
      "Comunidad Valenciana": ["Alicante","Castellón","Valencia"],
      "Ceuta": ["Ceuta"],
      "Melilla": ["Melilla"],
    },
    // Real Spain also has Granada (Andalucía) and León (Castilla y León) — missing from our
    // province list entirely (data gap, not a mapping issue).
  },
  "Algeria": {
    verdict: "grouping",
    groups: {
      "Northern Algeria - Center": ["Alger","Aïn Defla","Blida","Bouira","Boumerdès","Médéa","Tipaza","Tizi Ouzou","Djelfa"],
      "Northern Algeria - East": ["Annaba","Batna","Bordj Bou Arréridj","Béjaïa","Constantine","El Tarf","Guelma","Jijel","Khenchela","Mila","Oum el Bouaghi","Skikda","Souk Ahras","Sétif","Tébessa"],
      "Northern Algeria - West": ["Aïn Témouchent","Chlef","Mascara","Mostaganem","Oran","Relizane","Saïda","Sidi Bel Abbès","Tiaret","Tissemsilt","Tlemcen"],
      "Sahara / South": ["Adrar","Biskra","Béchar","El Bayadh","El Oued","Ghardaïa","Illizi","Laghouat","M'Sila","Naâma","Ouargla","Tamanghasset","Tindouf"],
    },
  },
  "Japan": {
    verdict: "grouping",
    groups: {
      "Hokkaido": ["Hokkaidō"],
      "Tōhoku": ["Aomori","Akita","Iwate","Yamagata","Miyagi","Fukushima"],
      "Kantō": ["Ibaraki","Tochigi","Gunma","Saitama","Chiba","Tokyo","Kanagawa"],
      "Chūbu": ["Niigata","Toyama","Ishikawa","Fukui","Yamanashi","Nagano","Gifu","Shizuoka","Aichi"],
      "Kansai (Kinki)": ["Mie","Shiga","Kyōto","Ōsaka","Hyōgo","Nara","Wakayama"],
      "Chūgoku": ["Tottori","Shimane","Okayama","Hiroshima","Yamaguchi"],
      "Shikoku": ["Tokushima","Kagawa","Ehime","Kōchi"],
      "Kyūshū": ["Fukuoka","Saga","Nagasaki","Kumamoto","Ōita","Miyazaki","Kagoshima","Okinawa"],
    },
  },
  "Burkina Faso": {
    verdict: "grouping",
    groups: {
      "Boucle du Mouhoun": ["Balé","Banwa","Kossi","Mou Houn","Nayala","Sourou"],
      "Cascades": ["Komoé","Léraba"],
      "Centre": ["Kadiogo"],
      "Centre-Est": ["Boulgou","Koulpélogo","Kouritenga"],
      "Centre-Nord": ["Bam","Namentenga","Sanmatenga"],
      "Centre-Ouest": ["Boulkiemdé","Sanguié","Sissili","Ziro"],
      "Centre-Sud": ["Bazéga","Nahouri","Zoundwéogo"],
      "Est": ["Gnagna","Gourma","Komondjari","Kompienga","Tapoa"],
      "Hauts-Bassins": ["Houet","Kénédougou","Tuy"],
      "Nord": ["Loroum","Passoré","Yatenga","Zondoma"],
      "Plateau-Central": ["Ganzourgou","Kourwéogo","Oubritenga"],
      "Sahel": ["Oudalan","Séno","Soum","Yagha"],
      "Sud-Ouest": ["Bougouriba","Ioba","Noumbiel","Poni"],
    },
  },
  "Hungary": {
    verdict: "grouping",
    groups: {
      "Budapest": ["Budapest"],
      "Baranya": ["Baranya","Pécs"],
      "Borsod-Abaúj-Zemplén": ["Borsod-Abaúj-Zemplén","Miskolc"],
      "Bács-Kiskun": ["Bács-Kiskun","Kecskemét"],
      "Békés": ["Békés","Békéscsaba"],
      "Csongrád": ["Csongrád","Szeged","Hódmezôvásárhely"],
      "Fejér": ["Fejér","Székesfehérvár","Dunaújváros"],
      "Gyor-Moson-Sopron": ["Gyor-Moson-Sopron","Gyôr","Sopron"],
      "Hajdú-Bihar": ["Hajdú-Bihar","Debrecen"],
      "Heves": ["Heves","Eger"],
      "Jász-Nagykun-Szolnok": ["Jász-Nagykun-Szolnok","Szolnok"],
      "Komárom-Esztergom": ["Komárom-Esztergom","Tatabánya"],
      "Nógrád": ["Nógrád","Salgótarján"],
      "Pest": ["Pest","Érd"],
      "Somogy": ["Somogy","Kaposvár"],
      "Szabolcs-Szatmár-Bereg": ["Szabolcs-Szatmár-Bereg","Nyíregyháza"],
      "Tolna": ["Tolna","Szekszárd"],
      "Vas": ["Vas","Szombathely"],
      "Veszprém": ["Veszprém"],
      "Zala": ["Zala","Nagykanizsa","Zalaegerszeg"],
    },
  },
  "Romania": {
    verdict: "grouping",
    groups: {
      "Nord-Vest": ["Bihor","Bistrita-Nasaud","Cluj","Maramures","Satu Mare","Salaj"],
      "Centru": ["Alba","Brasov","Covasna","Harghita","Mures","Sibiu"],
      "Nord-Est": ["Bacau","Botosani","Iasi","Neamt","Suceava","Vaslui"],
      "Sud-Est": ["Braila","Buzau","Constanta","Galati","Tulcea","Vrancea"],
      "Sud-Muntenia": ["Arges","Calarasi","Dâmbovita","Giurgiu","Ialomita","Prahova","Teleorman"],
      "Bucureşti-Ilfov": ["Bucharest","Ilfov"],
      "Sud-Vest Oltenia": ["Dolj","Gorj","Mehedinti","Olt","Vâlcea"],
      "Vest": ["Arad","Caras-Severin","Hunedoara","Timis"],
    },
  },
  "Moldova": {
    verdict: "grouping",
    groups: {
      "Nord": ["Bălţi","Briceni","Donduseni","Drochia","Edineţ","Făleşti","Floreşti","Glodeni","Ocniţa","Rîşcani","Sîngerei","Soroca"],
      "Centru": ["Anenii Noi","Călărași","Criuleni","Hîncesti","Ialoveni","Nisporeni","Orhei","Rezina","Străşeni","Şoldăneşti","Teleneşti","Ungheni"],
      "Sud": ["Basarabeasca","Cahul","Cantemir","Causeni","Cimişlia","Leova","Taraclia","Ștefan Vodă"],
      "Chişinău municipality": ["Chişinău"],
      "UTA Găgăuzia": ["Comrat"],
      "Transnistria": ["Bender","Camenca","Grigoriopol","Stîngă Nistrului","Transnistria"],
    },
  },
  "Nigeria": { verdict: "no_grouping" },
  "India": { verdict: "no_grouping" },
  "Indonesia": {
    verdict: "grouping",
    groups: {
      "Sumatera": ["Aceh","Sumatera Utara","Sumatera Barat","Riau","Kepulauan Riau","Jambi","Bengkulu","Sumatera Selatan","Bangka-Belitung","Lampung"],
      "Jawa": ["Jakarta Raya","Banten","Jawa Barat","Jawa Tengah","Yogyakarta","Jawa Timur"],
      "Kalimantan": ["Kalimantan Barat","Kalimantan Tengah","Kalimantan Selatan","Kalimantan Timur"],
      "Sulawesi": ["Sulawesi Utara","Gorontalo","Sulawesi Tengah","Sulawesi Barat","Sulawesi Selatan","Sulawesi Tenggara"],
      "Nusa Tenggara": ["Bali","Nusa Tenggara Barat","Nusa Tenggara Timur"],
      "Maluku": ["Maluku","Maluku Utara"],
      "Papua": ["Papua","Papua Barat"],
    },
  },
  "Egypt": {
    verdict: "grouping",
    groups: {
      "Greater Cairo": ["Al Qahirah","Al Jizah","Al Qalyubiyah"],
      "Alexandria & the North Coast": ["Al Iskandariyah","Matruh"],
      "The Nile Delta": ["Ad Daqahliyah","Al Buhayrah","Al Gharbiyah","Al Minufiyah","Ash Sharqiyah","Kafr ash Shaykh","Dumyat"],
      "The Suez Canal Zone": ["Al Isma`iliyah","As Suways","Bur Sa`id"],
      "Upper Egypt": ["Al Minya","Bani Suwayf","Asyut","Suhaj","Qina","Aswan","Luxor"],
      "The Red Sea Coast": ["Al Bahr al Ahmar"],
      "Sinai": ["Janub Sina'","Shamal Sina'"],
      "The Western Desert / New Valley Oases": ["Al Wadi at Jadid"],
      "Fayoum": ["Al Fayyum"],
    },
  },

  // ---- Worldwide batch 1 ----
  "Guinea": {
    verdict: "grouping",
    groups: {
      "Basse-Guinée (Maritime Guinea)": ["Boffa","Boke","Conakry","Coyah","Dubréka","Forécariah","Fria","Kindia","Télimélé"],
      "Moyenne-Guinée (Fouta Djallon)": ["Dalaba","Koubia","Labé","Lélouma","Mamou","Pita","Tougué"],
      "Haute-Guinée (Upper Guinea)": ["Dabola","Dinguiraye","Faranah","Kankan","Kissidougou","Kouroussa","Kérouané","Mandiana","Siguiri"],
      "Guinée Forestière (Forest Guinea)": ["Beyla","Guéckédou","Lola","Macenta","Nzérékoré","Yomou"],
    },
  },
  "China": { verdict: "no_grouping", disconnects: ["Paracel Islands"] },
  "Colombia": {
    verdict: "grouping",
    groups: {
      "Andina": ["Antioquia","Bogota","Boyacá","Caldas","Cundinamarca","Huila","Norte de Santander","Quindío","Risaralda","Santander","Tolima"],
      "Caribe": ["Atlántico","Bolívar","Cesar","La Guajira","Magdalena","Sucre"],
      "Pacífica": ["Cauca","Chocó","Nariño","Valle del Cauca"],
      "Orinoquía": ["Arauca","Casanare","Meta","Vichada"],
      "Amazonía": ["Caquetá","Guainía","Guaviare","Putumayo","Vaupés"],
    },
    disconnects: ["San Andrés y Providencia"],
  },
  "Ireland": {
    verdict: "grouping",
    groups: {
      "Leinster": ["Carlow","Dublin","Dún Laoghaire–Rathdown","Fingal","South Dublin","Kildare","Kilkenny","Laoighis","Longford","Louth","Meath","Offaly","Westmeath","Wexford","Wicklow"],
      "Munster": ["Clare","Cork","Kerry","Limerick","North Tipperary","South Tipperary","Waterford"],
      "Connacht": ["Galway","Leitrim","Mayo","Roscommon","Sligo"],
      "Ulster": ["Cavan","Donegal","Monaghan"],
    },
  },
  "Bahamas": {
    verdict: "grouping",
    groups: {
      "Abaco": ["Central Abaco","North Abaco","South Abaco","Moore's Island"],
      "Andros": ["Central Andros","North Andros","South Andros","Mangrove Cay"],
      "Eleuthera": ["Central Eleuthera","North Eleuthera","South Eleuthera","Harbour Island","Spanish Wells"],
      "Grand Bahama": ["City of Freeport","East Grand Bahama","West Grand Bahama"],
      "Exuma": ["Exuma","Black Point"],
      "Acklins/Crooked Island": ["Acklins","Crooked Island and Long Cay"],
    },
  },
  "Dominican Rep.": {
    verdict: "grouping",
    groups: {
      "Cibao": ["Dajabón","Duarte","Espaillat","Hermanas","La Vega","María Trinidad Sánchez","Monseñor Nouel","Monte Cristi","Puerto Plata","Samaná","Sánchez Ramírez","Santiago Rodríguez","Valverde"],
      "Sur": ["Azua","Bahoruco","Barahona","Independencia","La Estrelleta","Pedernales","Peravia","San José de Ocoa"],
      "Este": ["El Seybo","Hato Mayor","La Altagracia","La Romana","San Pedro de Macorís"],
      "Metropolitana/Ozama": ["Distrito Nacional","Monte Plata","San Cristóbal","Santo Domingo"],
    },
  },
  "Tanzania": {
    verdict: "no_grouping",
    disconnects: ["Kaskazini-Pemba","Kaskazini-Unguja","Kusini-Pemba","Zanzibar South and Central","Zanzibar West"],
  },
  "Malawi": {
    verdict: "grouping",
    groups: {
      "Northern Region": ["Chitipa","Likoma","Mzimba","Nkhata Bay","Rumphi"],
      "Central Region": ["Dedza","Dowa","Kasungu","Lilongwe","Mchinji","Nkhotakota","Ntcheu","Ntchisi","Salima"],
      "Southern Region": ["Balaka","Blantyre","Chikwawa","Chiradzulu","Machinga","Mangochi","Mulanje","Mwanza","Neno","Nsanje","Phalombe","Thyolo","Zomba"],
    },
  },
  "Brazil": {
    verdict: "grouping",
    groups: {
      "Norte": ["Acre","Amapá","Amazonas","Pará","Rondônia","Roraima","Tocantins"],
      "Nordeste": ["Alagoas","Bahia","Ceará","Maranhão","Paraíba","Pernambuco","Piauí","Rio Grande do Norte","Sergipe"],
      "Centro-Oeste": ["Distrito Federal","Goiás","Mato Grosso","Mato Grosso do Sul"],
      "Sudeste": ["Espírito Santo","Minas Gerais","Rio de Janeiro","São Paulo"],
      "Sul": ["Paraná","Rio Grande do Sul","Santa Catarina"],
    },
  },
  "Seychelles": {
    verdict: "grouping",
    groups: {
      "Mahé": ["Anse Boileau","Anse Etoile","Anse Royale","Anse aux Pins","Au Cap","Baie Lazare","Beau Vallon","Bel Air","Bel Ombre","Cascade","English River","Glacis","Grand'Anse","Les Mamelles","Mont Buxton","Mont Fleuri","Plaisance","Pointe La Rue","Port Glaud","Roche Caïman","Saint Louis","Takamaka"],
      "Praslin": ["Baie Sainte Anne","Grand'Anse Praslin"],
      "La Digue and Inner Islands": ["La Digue and Inner Islands"],
    },
    disconnects: ["Outer Islands"],
  },
  "Sri Lanka": {
    verdict: "grouping",
    groups: {
      "Western Province": ["Kŏḷamba","Gampaha","Kaḷutara"],
      "Central Province": ["Mahanuvara","Mātale","Nuvara Ĕliya"],
      "Southern Province": ["Gālla","Mātara","Hambantŏṭa"],
      "Northern Province": ["Yāpanaya","Kilinŏchchi","Mannārama","Vavuniyāva","Mulativ"],
      "Eastern Province": ["Trikuṇāmalaya","Maḍakalapuva","Ampāra"],
      "North Western Province": ["Kuruṇægala","Puttalama"],
      "North Central Province": ["Anurādhapura","Pŏḷŏnnaruva"],
      "Uva Province": ["Badulla","Mŏṇarāgala"],
      "Sabaragamuwa Province": ["Ratnapura","Kægalla"],
    },
  },
  "Peru": {
    verdict: "grouping",
    groups: {
      "Costa": ["Áncash","Arequipa","Callao","Ica","La Libertad","Lambayeque","Lima","Lima Province","Moquegua","Piura","Tacna","Tumbes"],
      "Sierra": ["Apurímac","Ayacucho","Cajamarca","Cusco","Huancavelica","Huánuco","Junín","Pasco","Puno"],
      "Selva": ["Loreto","Madre de Dios","San Martín","Ucayali"],
    },
  },

  // ---- Worldwide batch 2 ----
  "Ukraine": {
    verdict: "grouping",
    groups: {
      "West": ["Chernivtsi","Ivano-Frankivs'k","Khmel'nyts'kyy","L'viv","Rivne","Ternopil'","Transcarpathia","Volyn"],
      "Central": ["Cherkasy","Chernihiv","Kiev","Kiev City","Kirovohrad","Poltava","Vinnytsya","Zhytomyr"],
      "East": ["Dnipropetrovs'k","Donets'k","Kharkiv","Luhans'k","Sumy"],
      "South": ["Kherson","Mykolayiv","Odessa","Zaporizhzhya"],
    },
  },
  "Ecuador": {
    verdict: "grouping",
    groups: {
      "Costa": ["Esmeraldas","Manabi","Los Rios","Guayas","Santa Elena","El Oro","Santo Domingo de los Tsáchilas"],
      "Sierra": ["Carchi","Imbabura","Pichincha","Cotopaxi","Tungurahua","Chimborazo","Bolivar","Cañar","Azuay","Loja"],
      "Oriente": ["Sucumbios","Napo","Orellana","Pastaza","Morona Santiago","Zamora Chinchipe"],
    },
    disconnects: ["Galápagos"],
  },
  "Serbia": {
    verdict: "grouping",
    groups: {
      "Vojvodina": ["Južno-Backi","Južno-Banatski","Severno-Backi","Severno-Banatski","Srednje-Banatski","Sremski","Zapadno-Backi"],
      "Belgrade": ["Grad Beograd"],
      "Šumadija and Western Serbia": ["Zlatiborski","Kolubarski","Macvanski","Moravicki","Pomoravski","Raški","Šumadijski"],
      "Southern and Eastern Serbia": ["Borski","Branicevski","Jablanicki","Nišavski","Pirotski","Podunavski","Pcinjski","Toplicki","Zajecarski"],
    },
  },
  "Cambodia": {
    verdict: "grouping",
    groups: {
      "Coastal": ["Kaôh Kong","Kep","Krong Preah Sihanouk","Kâmpôt"],
      "Northeast Highlands": ["Krâchéh","Môndól Kiri","Rôtânôkiri","Stœng Trêng","Preah Vihéar"],
      "Northwest": ["Bântéay Méanchey","Batdâmbâng","Krong Pailin","Otdar Mean Chey","Siemréab","Pouthisat"],
      "Central Plains": ["Kâmpóng Cham","Kâmpóng Chhnang","Kâmpóng Spœ","Kâmpóng Thum","Kândal","Takêv","Prey Vêng","Svay Rieng"],
      "Capital": ["Phnom Penh"],
    },
  },
  "Tunisia": {
    verdict: "grouping",
    groups: {
      "District de Tunis": ["Tunis","Ben Arous (Tunis Sud)","Manubah"],
      "Nord Est": ["Bizerte","Nabeul","Zaghouan"],
      "Nord Ouest": ["Béja","Jendouba","Le Kef","Siliana"],
      "Centre Est (Sahel)": ["Sousse","Monastir","Mahdia","Sfax"],
      "Centre Ouest": ["Kairouan","Kassérine","Sidi Bou Zid"],
      "Sud Est": ["Gabès","Médenine","Tataouine"],
      "Sud Ouest": ["Gafsa","Tozeur","Kebili"],
    },
  },
  "New Zealand": {
    verdict: "grouping",
    groups: {
      "North Island": ["Auckland","Bay of Plenty","Gisborne District","Hawke's Bay","Manawatu-Wanganui","Northland","Taranaki","Waikato","Wellington"],
      "South Island": ["Canterbury","Marlborough District","Nelson City","Otago","Southland","Tasman District"],
    },
    disconnects: ["Antipodes Islands","Auckland Islands","Campbell Islands","Chatham Islands Territory","Kermadec Islands","The Snares","Three Kings Islands","Tokelau"],
  },
  "Venezuela": {
    verdict: "grouping",
    groups: {
      "Capital": ["Distrito Capital","Miranda","Vargas"],
      "Central": ["Aragua","Carabobo"],
      "Central-Western": ["Falcón","Lara","Yaracuy"],
      "Andes": ["Mérida","Táchira","Trujillo"],
      "Los Llanos": ["Apure","Barinas","Cojedes","Guárico","Portuguesa"],
      "Zulia": ["Zulia"],
      "Nor-Oriental": ["Anzoátegui","Delta Amacuro","Monagas"],
    },
    disconnects: ["Nueva Esparta","Dependencias Federales"],
  },
  "Libya": {
    verdict: "grouping",
    groups: {
      "Tripolitania": ["Al Jifarah","Al Marqab","An Nuqat al Khams","Az Zawiyah","Ghadamis","Misratah","Mizdah","Surt","Tajura' wa an Nawahi al Arba"],
      "Cyrenaica": ["Ajdabiya","Al Butnan","Al Jabal al Akhdar","Al Kufrah","Al Marj","Al Qubbah","Benghazi"],
      "Fezzan": ["Al Jufrah","Ash Shati'","Ghat","Murzuq","Sabha","Wadi al Hayaa"],
    },
  },
  "Mongolia": {
    verdict: "grouping",
    groups: {
      "Western": ["Bayan-Ölgiy","Govi-Altay","Hovd","Uvs","Dzavhan"],
      "Khangai": ["Arhangay","Bayanhongor","Bulgan","Orhon","Övörhangay","Hövsgöl"],
      "Central": ["Darhan-Uul","Dornogovi","Dundgovi","Govĭ-Sümber","Ömnögovi","Selenge","Töv"],
      "Eastern": ["Dornod","Hentiy","Sühbaatar"],
      "Ulaanbaatar": ["Ulaanbaatar"],
    },
  },
  "Chad": {
    verdict: "grouping",
    groups: {
      "Saharan North": ["Tibesti","Borkou","Ennedi","Wadi Fira"],
      "Sahelian Center": ["Kanem","Lac","Batha","Hadjer-Lamis","Chari-Baguirmi","Guéra","Salamat","Ouaddaï","Sila","Barh El Gazel"],
      "Sudanian South": ["Logone Occidental","Logone Oriental","Mandoul","Mayo-Kebbi Est","Mayo-Kebbi Ouest","Moyen-Chari","Tandjilé"],
      "Capital": ["Ville de N'Djamena"],
    },
  },
  "Taiwan": {
    verdict: "grouping",
    groups: {
      "Northern": ["Taipei City","New Taipei City","Keelung City","Taoyuan","Hsinchu","Hsinchu City","Yilan"],
      "Central": ["Taichung City","Changhua","Nantou","Yunlin","Miaoli"],
      "Southern": ["Tainan City","Kaohsiung City","Chiayi","Chiayi City","Pingtung"],
      "Eastern": ["Hualien","Taitung"],
    },
    disconnects: ["Kinmen","Penghu"],
  },
  "Norway": {
    verdict: "grouping",
    groups: {
      "Østlandet": ["Akershus","Oslo","Hedmark","Oppland","Buskerud","Vestfold","Østfold","Telemark"],
      "Sørlandet": ["Aust-Agder","Vest-Agder"],
      "Vestlandet": ["Hordaland","Rogaland","Sogn og Fjordane","Møre og Romsdal"],
      "Trøndelag": ["Nord-Trøndelag","Sør-Trøndelag"],
      "Nord-Norge": ["Nordland","Troms","Finnmark"],
    },
    disconnects: ["Svalbard","Bouvet Island"],
  },
  "Guatemala": {
    verdict: "grouping",
    groups: {
      "Norte": ["Alta Verapaz","Baja Verapaz"],
      "Nororiente": ["Chiquimula","El Progreso","Izabal","Zacapa"],
      "Suroriente": ["Jalapa","Jutiapa","Santa Rosa"],
      "Central": ["Chimaltenango","Escuintla","Sacatepéquez"],
      "Suroccidente": ["Quezaltenango","Retalhuleu","San Marcos","Sololá","Suchitepéquez","Totonicapán"],
      "Noroccidente": ["Huehuetenango","Quiché"],
      "Petén": ["Petén"],
    },
  },
  "Montenegro": {
    verdict: "grouping",
    groups: {
      "Coastal": ["Bar","Budva","Herceg Novi","Kotor","Tivat","Ulcinj"],
      "Central": ["Cetinje","Danilovgrad","Podgorica"],
      "Northern": ["Andrijevica","Berane","Bijelo Polje","Kolašin","Mojkovac","Nikšic","Plav","Pljevlja","Plužine","Rožaje","Šavnik","Žabljak"],
    },
  },
  "Sweden": {
    verdict: "grouping",
    groups: {
      "Norrland": ["Norrbotten","Västerbotten","Västernorrland","Jämtland","Gävleborg"],
      "Svealand": ["Stockholm","Uppsala","Södermanland","Orebro","Västmanland","Dalarna","Värmland"],
      "Götaland": ["Östergötland","Jönköping","Kronoberg","Kalmar","Gotland","Blekinge","Skåne","Halland","Västra Götaland"],
    },
  },
  "Madagascar": {
    verdict: "grouping",
    groups: {
      "Antananarivo": ["Analamanga","Bongolava","Itasy","Vakinankaratra"],
      "Antsiranana": ["Diana","Sava"],
      "Fianarantsoa": ["Amoron'i Mania","Atsimo-Atsinanana","Haute Matsiatra","Ihorombe","Vatovavy-Fitovinany"],
      "Mahajanga": ["Betsiboka","Boeny","Melaky"],
      "Toamasina": ["Alaotra-Mangoro","Analanjirofo","Atsinanana"],
      "Toliara": ["Androy","Anosy","Atsimo-Andrefana","Menabe"],
    },
  },
  "Maldives": {
    verdict: "grouping",
    groups: {
      "Northern Atolls": ["Haa Alifu","Haa Dhaalu","Shaviyani","Noonu","Raa","Lhaviyani","Baa"],
      "Central Atolls": ["Kaafu","Alifu Alifu","Alifu Dhaalu","Vaavu","Faafu","Dhaalu","Malé"],
      "Southern Atolls": ["Meemu","Laamu","Thaa","Gaafu Alifu","Gaafu Dhaalu","Gnaviyani","Addu"],
    },
  },
  "Portugal": {
    verdict: "grouping",
    groups: {
      "Norte": ["Braga","Bragança","Porto","Viana do Castelo","Vila Real"],
      "Centro": ["Aveiro","Castelo Branco","Coimbra","Guarda","Leiria","Viseu"],
      "Lisboa": ["Lisboa"],
      "Alentejo": ["Beja","Évora","Portalegre","Santarém","Setúbal"],
      "Algarve": ["Faro"],
    },
    disconnects: ["Azores","Madeira"],
  },
  "Cabo Verde": {
    verdict: "grouping",
    groups: {
      "Barlavento": ["Paul","Porto Novo","Ribeira Grande","São Vicente","Ribeira Brava","Tarrafal de São Nicolau","Sal","Boa Vista"],
      "Sotavento": ["Praia","Ribeira Grande de Santiago","São Domingos","São Lourenço dos Órgãos","São Miguel","São Salvador do Mundo","Tarrafal","Mosteiros","São Filipe","Santa Catarina do Fogo","Brava","Maio"],
    },
  },

  // ---- Worldwide batch 3 ----
  "Yemen": { verdict: "no_grouping" },
  "Croatia": {
    verdict: "grouping",
    groups: {
      "Dalmacija": ["Dubrovacko-Neretvanska","Splitsko-Dalmatinska","Šibensko-Kninska","Zadarska"],
      "Istra": ["Istarska"],
      "Kvarner": ["Primorsko-Goranska"],
      "Lika": ["Licko-Senjska"],
      "Slavonija": ["Brodsko-Posavska","Osjecko-Baranjska","Viroviticko-Podravska","Vukovarsko-Srijemska"],
      "Središnja Hrvatska": ["Grad Zagreb","Zagrebacka","Karlovacka","Sisacko-Moslavacka","Bjelovarsko-bilogorska","Koprivničko-Križevačka","Krapinsko-Zagorska","Varaždinska","Medimurska"],
    },
  },
  "Bhutan": {
    verdict: "grouping",
    groups: {
      "Western Bhutan": ["Ha","Paro","Thimphu","Punakha","Wangdi Phodrang","Chhukha","Samchi","Gasa"],
      "Central Bhutan": ["Bumthang","Tongsa","Shemgang","Chirang","Daga","Geylegphug"],
      "Eastern Bhutan": ["Mongar","Lhuntshi","Tashigang","Tashi Yangtse","Pemagatsel","Samdrup Jongkhar"],
    },
  },
  "Argentina": {
    verdict: "grouping",
    groups: {
      "NOA": ["Catamarca","Jujuy","Salta","Santiago del Estero","Tucumán"],
      "NEA": ["Chaco","Corrientes","Formosa"],
      "Cuyo": ["Mendoza","San Juan","San Luis"],
      "Pampas/Centro": ["Buenos Aires","Ciudad de Buenos Aires","Entre Ríos","La Pampa","Santa Fe"],
      "Patagonia": ["Chubut","Neuquén"],
    },
    disconnects: ["Tierra del Fuego"],
  },
  "Côte d'Ivoire": { verdict: "no_grouping" },
  "Bosnia and Herz.": {
    verdict: "grouping",
    groups: {
      "Federation of Bosnia and Herzegovina": ["Bosnian Podrinje","Central Bosnia","Herzegovina-Neretva","Posavina","Sarajevo","Tuzla","Una-Sana","West Bosnia","West Herzegovina","Zenica-Doboj"],
      "Republika Srpska": ["Banja Luka","Bijeljina","Doboj","Foča","Sarajevo-romanija","Trebinje","Vlasenica"],
      "Brčko Distrikt": ["Brčko Distrikt"],
    },
  },
  "Iraq": {
    verdict: "grouping",
    groups: { "Kurdistan Region": ["Arbil","As-Sulaymaniyah","Dihok"] },
  },
  "Finland": { verdict: "no_grouping" },
  "Angola": { verdict: "no_grouping", disconnects: ["Cabinda"] },
  "Honduras": { verdict: "no_grouping", disconnects: ["Islas de la Bahía","Gracias a Dios"] },
  "Uruguay": { verdict: "no_grouping" },
  "Paraguay": {
    verdict: "grouping",
    groups: {
      "Región Occidental (Chaco)": ["Alto Paraguay","Boquerón","Presidente Hayes"],
      "Región Oriental": ["Alto Paraná","Amambay","Asunción","Caaguazú","Caazapá","Canindeyú","Concepción","Cordillera","Guairá","Itapúa","Misiones","Paraguarí","San Pedro","Ñeembucú"],
    },
  },
  "Papua New Guinea": {
    verdict: "grouping",
    groups: {
      "Highlands Region": ["Chimbu","Eastern Highlands","Enga","Southern Highlands","Western Highlands"],
      "Islands Region": ["East New Britain","Manus","New Ireland","West New Britain"],
      "Momase Region": ["East Sepik","Madang","Morobe","Sandaun"],
      "Southern Region": ["Gulf","Milne Bay","National Capital District"],
    },
    disconnects: ["North Solomons"],
  },
  "Laos": {
    verdict: "grouping",
    groups: {
      "Northern Laos": ["Bokeo","Houaphan","Louang Namtha","Louangphrabang","Oudômxai","Phôngsali","Xaignabouri","Xiangkhoang"],
      "Central Laos": ["Bolikhamxai","Khammouan","Vientiane","Vientiane [prefecture]","Savannakhét"],
      "Southern Laos": ["Attapu","Champasak","Saravan","Xékong"],
    },
  },
  "Central African Rep.": { verdict: "no_grouping" },
  "Nicaragua": { verdict: "no_grouping", disconnects: ["Atlántico Norte","Atlántico Sur"] },
  "South Korea": { verdict: "no_grouping", disconnects: ["Jeju"] },
  "Burundi": { verdict: "no_grouping" },

  // ---- Worldwide batch 4 ----
  "Sudan": {
    verdict: "grouping",
    groups: {
      "Darfur": ["Central Darfur","Eastern Darfur","North Darfur","Southern Darfur","Western Darfur"],
      "Kordofan": ["North Kordufan","South Kordofan"],
    },
  },
  "Poland": { verdict: "no_grouping" },
  "Palau": {
    verdict: "grouping",
    groups: {
      "Babeldaob": ["Aimeliik","Airai","Melekeok","Ngaraard","Ngarchelong","Ngardmau","Ngatpang","Ngchesar","Ngeremlengui","Ngiwal"],
      "Koror": ["Koror"],
      "Southern Islands": ["Peleliu","Angaur"],
      "Kayangel Atoll": ["Kayangel"],
    },
    disconnects: ["Sonsorol","Hatobohei"],
  },
  "Chile": {
    verdict: "grouping",
    groups: {
      "Norte Grande": ["Arica y Parinacota","Tarapacá","Antofagasta"],
      "Norte Chico": ["Atacama","Coquimbo"],
      "Zona Central": ["Valparaíso","Región Metropolitana de Santiago","Libertador General Bernardo O'Higgins","Maule","Ñuble","Bío-Bío"],
      "Zona Sur": ["La Araucanía","Los Ríos","Los Lagos"],
      "Zona Austral": ["Aisén del General Carlos Ibáñez del Campo","Magallanes y Antártica Chilena"],
    },
  },
  "Cuba": {
    verdict: "grouping",
    groups: {
      "Occidente": ["Pinar del Río","Artemisa","Ciudad de la Habana","Mayabeque","Isla de la Juventud","Matanzas"],
      "Centro": ["Cienfuegos","Villa Clara","Sancti Spíritus","Ciego de Ávila","Camagüey"],
      "Oriente": ["Las Tunas","Holguín","Granma","Santiago de Cuba","Guantánamo"],
    },
  },
  "Germany": { verdict: "no_grouping" },
  "Mauritius": {
    verdict: "grouping",
    groups: {
      "Mauritius (main island)": ["Beau Bassin-Rose Hill","Curepipe","Flacq","Grand Port","Moka","Pamplemousses","Plaines Wilhems","Port Louis","Port Louis city","Quatre Bornes","Rivière Noire","Rivière du Rempart","Savanne","Vacoas-Phoenix"],
    },
    disconnects: ["Rodrigues","Agaléga"],
  },
  "Malaysia": {
    verdict: "grouping",
    groups: {
      "Peninsular Malaysia": ["Johor","Kedah","Kelantan","Kuala Lumpur","Melaka","Negeri Sembilan","Pahang","Perak","Perlis","Pulau Pinang","Putrajaya","Selangor","Terengganu"],
      "East Malaysia (Borneo)": ["Labuan","Sabah","Sarawak"],
    },
  },
  "Morocco": {
    verdict: "grouping",
    groups: {
      "North (Rif/Mediterranean)": ["Tanger - Tétouan","Taza - Al Hoceima - Taounate","Oriental"],
      "Atlantic Coast/Central Plains": ["Gharb - Chrarda - Béni Hssen","Rabat - Salé - Zemmour - Zaer","Grand Casablanca","Chaouia - Ouardigha","Doukkala - Abda"],
      "Atlas & Interior": ["Fès - Boulemane","Meknès - Tafilalet","Tadla - Azilal","Marrakech - Tensift - Al Haouz","Souss - Massa - Draâ"],
      "Sahara/South": ["Guelmim - Es-Semara","Laâyoune - Boujdour - Sakia El Hamra","Oued el Dahab"],
    },
  },
  "Trinidad and Tobago": {
    verdict: "grouping",
    groups: {
      "Trinidad": ["Arima","Chaguanas","Couva-Tabaquite-Talparo","Diego Martin","Penal-Debe","Point Fortin","Port of Spain","Princes Town","Rio Claro-Mayaro","San Fernando","San Juan-Laventille","Sangre Grande","Siparia","Tunapuna/Piarco"],
      "Tobago": ["Eastern Tobago","Western Tobago"],
    },
  },
  "Hong Kong": {
    verdict: "grouping",
    groups: {
      "Hong Kong Island": ["Central and Western","Wan Chai"],
      "Kowloon": ["Kowloon City","Kwun Tong","Sham Shui Po","Wong Tai Sin","Yau Tsim Mong"],
      "New Territories": ["Islands","Kwai Tsing","North","Sai Kung","Sha Tin","Tai Po","Tsuen Wan","Tuen Mun","Yuen Long"],
    },
  },
  "Kazakhstan": { verdict: "no_grouping" },
  "Liberia": { verdict: "no_grouping" },
  "Syria": { verdict: "no_grouping" },
  "Estonia": { verdict: "no_grouping" },
  "Nauru": { verdict: "no_grouping" },
  "Anguilla": { verdict: "no_grouping" },
  "Czechia": { verdict: "no_grouping" },

  // ---- Worldwide batch 5 ----
  "Myanmar": { verdict: "no_grouping" },
  "St. Kitts and Nevis": {
    verdict: "grouping",
    groups: {
      "Saint Kitts": ["Christ Church Nichola Town","Saint Anne Sandy Point","Saint George Basseterre","Saint John Capesterre","Saint Mary Cayon","Saint Paul Capesterre","Saint Peter Basseterre","Saint Thomas Middle Island","Trinity Palmetto Point"],
      "Nevis": ["Saint George Gingerland","Saint James Windward","Saint John Figtree","Saint Paul Charlestown","Saint Thomas Lowland"],
    },
  },
  "Netherlands": { verdict: "no_grouping", disconnects: ["Bonaire","Saba","St. Eustatius"] },
  "Greece": {
    verdict: "grouping",
    groups: {
      "Mainland Greece": ["Anatoliki Makedonia kai Thraki","Attiki","Dytiki Ellada","Dytiki Makedonia","Ipeiros","Kentriki Makedonia","Peloponnisos","Stereá Elláda","Thessalia"],
      "Ionian Islands": ["Ionioi Nisoi"],
      "Aegean Islands": ["Notio Aigaio","Voreio Aigaio"],
    },
    disconnects: ["Kriti","Ayion Oros"],
  },
  "Nepal": {
    verdict: "grouping",
    groups: {
      "Eastern": ["Mechi","Bhojpur","Sagarmatha"],
      "Central": ["Janakpur","Bagmati","Narayani"],
      "Western": ["Gandaki","Dhawalagiri","Lumbini"],
      "Mid-Western": ["Rapti","Bheri","Karnali"],
      "Far-Western": ["Seti","Mahakali"],
    },
  },
  "Senegal": { verdict: "no_grouping" },
  "Timor-Leste": { verdict: "no_grouping", disconnects: ["Ambeno"] },
  "Botswana": { verdict: "no_grouping" },
  "Canada": { verdict: "no_grouping" },
  "Uzbekistan": { verdict: "no_grouping" },
  "Namibia": { verdict: "no_grouping", disconnects: ["Caprivi"] },
  "Saudi Arabia": { verdict: "no_grouping" },
  "Georgia": { verdict: "no_grouping", disconnects: ["Abkhazia"] },
  "Congo": { verdict: "no_grouping" },
  "Albania": { verdict: "no_grouping" },
  "Jordan": { verdict: "no_grouping", disconnects: ["Aqaba"] },
  "Somalia": { verdict: "no_grouping" },
  "Mauritania": { verdict: "no_grouping" },

  // ---- Worldwide batch 6 ----
  "Bermuda": { verdict: "no_grouping" },
  "Saint Lucia": { verdict: "no_grouping" },
  "El Salvador": {
    verdict: "grouping",
    groups: {
      "Occidental": ["Ahuachapán","Santa Ana","Sonsonate"],
      "Central": ["Cabañas","Chalatenango","Cuscatlán","San Vicente"],
      "Oriental": ["La Unión","Morazán","San Miguel","Usulután"],
    },
  },
  "Australia": { verdict: "no_grouping", disconnects: ["Lord Howe Island","Macquarie Island"] },
  "Samoa": { verdict: "no_grouping" },
  "North Korea": { verdict: "no_grouping" },
  "Cook Is.": {
    verdict: "grouping",
    groups: {
      "Southern Cook Islands": ["Rarotonga","Aitutaki","Atiu","Mangaia","Mauke","Mitiaro","Palmerston"],
      "Northern Cook Islands": ["Manihiki","Penrhyn","Pukapuka","Rakahanga"],
    },
  },
  "Benin": { verdict: "no_grouping" },
  "Ethiopia": { verdict: "no_grouping" },
  "Dem. Rep. Congo": { verdict: "no_grouping" },
  "Oman": { verdict: "no_grouping" },
  "Armenia": { verdict: "no_grouping" },
  "Jamaica": {
    verdict: "grouping",
    groups: {
      "Cornwall": ["Hanover","Saint Elizabeth","Trelawny","Westmoreland"],
      "Middlesex": ["Clarendon","Manchester","Saint Ann","Saint Catherine","Saint Mary"],
      "Surrey": ["Kingston","Portland"],
    },
  },
  "Liechtenstein": {
    verdict: "grouping",
    groups: {
      "Oberland": ["Vaduz","Schaan","Balzers","Triesen","Triesenberg","Planken"],
      "Unterland": ["Eschen","Mauren","Gamprin","Ruggell","Schellenberg"],
    },
  },
  "Åland": { verdict: "no_grouping" },
  "Lithuania": { verdict: "no_grouping" },
  "Panama": { verdict: "no_grouping", disconnects: ["Kuna Yala"] },
  "Lesotho": { verdict: "no_grouping" },
  "Zimbabwe": { verdict: "no_grouping" },

  // ---- Worldwide batch 7 ----
  "Guyana": { verdict: "no_grouping" },
  "Belgium": {
    verdict: "grouping",
    groups: {
      "Flanders": ["Antwerp","East Flanders","Flemish Brabant","Limburg","West Flanders"],
      "Wallonia": ["Hainaut","Liege","Namur","Walloon Brabant"],
      "Brussels-Capital": ["Brussels"],
    },
  },
  "Mozambique": { verdict: "no_grouping" },
  "S. Sudan": { verdict: "no_grouping" },
  "Suriname": { verdict: "no_grouping" },
  "Guinea-Bissau": { verdict: "no_grouping", disconnects: ["Bolama"] },
  "Iceland": { verdict: "no_grouping" },
  "Austria": { verdict: "no_grouping" },
  "Mali": { verdict: "no_grouping" },
  "Gabon": { verdict: "no_grouping" },
  "Solomon Is.": { verdict: "no_grouping" },
  "South Africa": { verdict: "no_grouping" },
  "U.S. Minor Outlying Is.": {
    verdict: "no_grouping",
    disconnects: ["Baker Island","Howland Island","Jarvis Island","Johnston Atoll","Midway Islands","Navassa Island","Palmyra Atoll","Wake Atoll"],
  },
  "Bolivia": { verdict: "no_grouping" },
  "Barbados": { verdict: "no_grouping" },
  "Haiti": { verdict: "no_grouping" },
  "San Marino": { verdict: "no_grouping" },
  "Kyrgyzstan": { verdict: "no_grouping" },
  "Pakistan": {
    verdict: "grouping",
    groups: {
      "Provinces": ["Punjab","Sind","K.P.","Baluchistan"],
      "Federal Capital": ["F.C.T."],
      "Disputed/Autonomous Territories": ["Azad Kashmir","Northern Areas","F.A.T.A."],
    },
  },
  "Niger": { verdict: "no_grouping" },
  "Slovakia": { verdict: "no_grouping" },

  // ---- Worldwide batch 8 ----
  "United Arab Emirates": { verdict: "no_grouping" },
  "Belarus": { verdict: "no_grouping" },
  "Grenada": { verdict: "no_grouping", disconnects: ["Carriacou and Petite Martinique"] },
  "Bangladesh": { verdict: "no_grouping" },
  "Qatar": { verdict: "no_grouping" },
  "Andorra": { verdict: "no_grouping" },
  "Zambia": { verdict: "no_grouping" },
  "Eq. Guinea": { verdict: "no_grouping", disconnects: ["Annobón"] },
  "Costa Rica": { verdict: "no_grouping" },
  "Gambia": { verdict: "no_grouping" },
  "Eritrea": { verdict: "no_grouping" },
  "Israel": { verdict: "no_grouping" },
  "Ghana": { verdict: "no_grouping" },
  "Kuwait": { verdict: "no_grouping" },
  "Lebanon": { verdict: "no_grouping" },
  "Kenya": { verdict: "no_grouping" },
  "Turks and Caicos Is.": {
    verdict: "grouping",
    groups: {
      "Turks Islands": ["Grand Turk","Salt Cay"],
      "Caicos Islands": ["Middle Caicos","North Caicos","Providenciales and West Caicos","South Caicos and East Caicos"],
    },
  },
  "Vanuatu": { verdict: "no_grouping" },
  "Greenland": { verdict: "no_grouping" },
};
