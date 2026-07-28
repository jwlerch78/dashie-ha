/* ============================================================
   Emoji Picker — matches mobile app (searchable, categorized)
   ============================================================ */

const EmojiPicker = {
    _open: false,
    _onSelect: null,
    _searchQuery: '',
    _activeCategory: 'frequent',
    _SEARCH_LIMIT: 150,

    CATEGORIES: {
        frequent: {
            name: 'Frequent',
            icon: '🕐',
            emojis: [
                '🧹', '🧽', '🧺', '🛏️', '🍽️', '📚', '✏️', '🎒', '🐕', '🐈',
                '🚗', '🗑️', '♻️', '✅', '⭐', '💪', '🎯', '🏆', '🎉', '✨',
                '💯', '👕', '🧦', '🌱', '🪴', '🚿', '🐾', '📝', '🎁', '❤️',
            ],
        },
        rewards: {
            name: 'Rewards',
            icon: '🎁',
            emojis: [
                '🍕', '🍔', '🍟', '🌭', '🍿', '🍦', '🍨', '🍧', '🍩', '🍪',
                '🧁', '🍰', '🎂', '🍭', '🍬', '🍫', '🥤', '🧋', '☕', '🥛',
                '🎢', '🎡', '🎠', '🎪', '🎬', '🎮', '🕹️', '🎯', '🎳', '🎲',
                '🛝', '⛳', '🏊', '🏄', '🛹', '🎿', '⛷️', '🏂', '🎣', '🏕️',
                '🏖️', '🏝️', '⛱️', '🌊', '🏞️', '🎭', '🎤', '🎧', '🎸', '🎹',
                '🎨', '🖼️', '📸', '🛍️', '💈', '💅', '🧖', '♨️', '🏨', '🗼',
                '📱', '💻', '🖥️', '📺', '🎥', '📽️', '📲', '⌚',
                '🎁', '🎉', '🎊', '🎈', '🎀', '🏆', '🥇', '👑', '💎', '🌟',
                '🚲', '🛴', '🛼', '🏓', '🏸', '⚽', '🏀', '🎾', '🏐', '🤿',
                '🧸', '🌙', '⭐', '✨', '💤', '🌈',
            ],
        },
        smileys: {
            name: 'Smileys',
            icon: '😀',
            emojis: [
                '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊',
                '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋', '😛', '😜',
                '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐',
                '😑', '😶', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '😌', '😔',
                '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵',
                '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐',
                '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦',
                '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞',
                '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿',
                '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖',
            ],
        },
        people: {
            name: 'People',
            icon: '👋',
            emojis: [
                '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
                '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
                '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
                '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂',
                '🦻', '👃', '🧒', '👦', '👧', '🧑', '👱', '👨', '🧔', '👩',
                '🧓', '👴', '👵', '👶', '👼', '👸', '🤴', '🧙', '🧚', '🧛',
                '🧜', '🧝', '🧞', '🧟', '💆', '💇', '🚶', '🧍', '🧎', '🏃',
                '💃', '🕺', '🕴️', '👯', '🧖', '🧗', '🤸', '🏌️', '🏇', '⛷️',
                '👫', '👬', '👭', '💏', '💑', '👪',
            ],
        },
        animals: {
            name: 'Animals',
            icon: '🐶',
            emojis: [
                '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈',
                '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴', '🐎', '🦄', '🦓', '🦌',
                '🦬', '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏',
                '🐑', '🐐', '🐪', '🐫', '🦙', '🦒', '🐘', '🦣', '🦏', '🦛',
                '🐭', '🐁', '🐀', '🐹', '🐰', '🐇', '🐿️', '🦫', '🦔', '🦇',
                '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡', '🐾',
                '🦃', '🐔', '🐓', '🐣', '🐤', '🐥', '🐦', '🐧', '🕊️', '🦅',
                '🦆', '🦢', '🦉', '🦤', '🪶', '🦩', '🦚', '🦜', '🐸', '🐊',
                '🐢', '🦎', '🐍', '🐲', '🐉', '🦕', '🦖', '🐳', '🐋', '🐬',
                '🦭', '🐟', '🐠', '🐡', '🦈', '🐙', '🐚', '🐌', '🦋', '🐛',
                '🐜', '🐝', '🪲', '🐞', '🦗', '🪳', '🕷️', '🕸️', '🦂', '🦟',
            ],
        },
        food: {
            name: 'Food',
            icon: '🍎',
            emojis: [
                '🍎', '🍏', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
                '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑',
                '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅',
                '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳',
                '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔',
                '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗',
                '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟',
                '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡',
                '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬',
                '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '☕',
                '🫖', '🍵', '🧃', '🥤', '🧋',
            ],
        },
        activities: {
            name: 'Activities',
            icon: '⚽',
            emojis: [
                '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
                '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳',
                '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷',
                '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️',
                '🤺', '🤾', '🏌️', '🏇', '⛑️', '🎖️', '🏅', '🥇', '🥈', '🥉',
                '🏆', '🎮', '🕹️', '🎲', '🃏', '🀄', '🎴', '🎭', '🖼️', '🎨',
                '🧵', '🪡', '🧶', '🪢', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘',
                '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🎬', '🎥', '📽️', '🎞️',
                '📹', '📷', '📸', '📼', '💡', '🔦', '🏮', '🪔',
            ],
        },
        travel: {
            name: 'Travel',
            icon: '🚗',
            emojis: [
                '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐',
                '🛻', '🚚', '🚛', '🚜', '🦯', '🦽', '🦼', '🛴', '🚲', '🛵',
                '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟',
                '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇',
                '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸',
                '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '⛽',
                '🚧', '🚦', '🚥', '🚏', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯',
                '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋',
                '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏘️',
            ],
        },
        objects: {
            name: 'Objects',
            icon: '💻',
            emojis: [
                '💻', '🖥️', '🖨️', '⌨️', '🖱️', '🖲️', '💽', '💾', '💿', '📀',
                '🧮', '🎥', '🎞️', '📽️', '🎬', '📺', '📷', '📸', '📹', '📼',
                '🔍', '🔎', '🕯️', '💡', '🔦', '🏮', '🪔', '📔', '📕', '📖',
                '📗', '📘', '📙', '📚', '📓', '📒', '📃', '📜', '📄', '📰',
                '🗞️', '📑', '🔖', '🏷️', '💰', '🪙', '💴', '💵', '💶', '💷',
                '💸', '💳', '🧾', '💹', '✉️', '📧', '📨', '📩', '📤', '📥',
                '📦', '📫', '📪', '📬', '📭', '📮', '🗳️', '✏️', '✒️', '🖋️',
                '🖊️', '🖌️', '🖍️', '📝', '💼', '📁', '📂', '🗂️', '📅', '📆',
                '🗒️', '🗓️', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎',
                '🖇️', '📏', '📐', '✂️', '🗃️', '🗄️', '🗑️', '🔒', '🔓', '🔏',
                '🔐', '🔑', '🗝️', '🔨', '🪓', '⛏️', '⚒️', '🛠️', '🗡️', '⚔️',
                '🛡️', '🪚', '🔧', '🪛', '🔩', '⚙️', '🗜️', '⚖️', '🔗', '⛓️',
                '🧰', '🧲', '🪜', '⚗️', '🧪', '🧫', '🧬', '🔬', '🔭', '📡',
                '💉', '🩸', '💊', '🩹', '🩺', '🚪', '🪞', '🪟', '🛏️', '🛋️',
                '🪑', '🚽', '🚿', '🛁', '🪒', '🧴', '🧷', '🧹', '🧺', '🧻',
                '🪣', '🧼', '🪥', '🧽', '🧯', '🛒', '📱', '📲', '☎️', '📞',
                '🔋', '🔌', '⏰', '⏱️', '⏲️', '🕰️', '⌚', '🔮', '🧿', '🎰',
            ],
        },
        symbols: {
            name: 'Symbols',
            icon: '❤️',
            emojis: [
                '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
                '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
                '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐',
                '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐',
                '♑', '♒', '♓', '⚛️', '☢️', '☣️', '📴', '📳', '💯', '💢',
                '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕',
                '❓', '❔', '‼️', '⁉️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️',
                '✅', '❌', '⭕', '🛑', '⛔', '🚫', '✔️', '☑️', '❎', '🌐',
                '💠', '🌀', '💤', '♿', '🆘', '🆕', '🆓', '🆗', '🆙', '🆒',
                '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣',
                '🔟', '#️⃣', '*️⃣', '▶️', '⏸️', '⏯️', '⏹️', '⏺️', '⏭️', '⏮️',
                '⏩', '⏪', '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️',
                '↘️', '↙️', '↖️', '↕️', '↔️', '↪️', '↩️', '🔀', '🔁', '🔂',
                '🔄', '🔃', '➕', '➖', '➗', '✖️', '♾️', '💲', '™️', '©️',
                '®️', '✔️', '🔘', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫',
                '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶', '🔷',
            ],
        },
        nature: {
            name: 'Nature',
            icon: '🌸',
            emojis: [
                '💐', '🌸', '💮', '🏵️', '🌹', '🥀', '🌺', '🌻', '🌼', '🌷',
                '🌱', '🪴', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀',
                '🍁', '🍂', '🍃', '🍄', '🌰', '🌍', '🌎', '🌏', '🌐', '🪨',
                '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘', '🌙', '🌚',
                '🌛', '🌜', '☀️', '🌝', '🌞', '🪐', '⭐', '🌟', '🌠', '🌌',
                '☁️', '⛅', '⛈️', '🌤️', '🌥️', '🌦️', '🌧️', '🌨️', '🌩️', '🌪️',
                '🌫️', '🌬️', '🌀', '🌈', '🌂', '☂️', '☔', '⚡', '❄️', '☃️',
                '⛄', '☄️', '🔥', '💧', '🌊', '✨', '💫',
            ],
        },
    },

    // Keyword index for search — copied from mobile app
    KEYWORDS: {
        '💻': 'laptop computer mac pc notebook',
        '🖥️': 'desktop computer monitor screen display',
        '🖨️': 'printer print',
        '⌨️': 'keyboard type typing',
        '🖱️': 'mouse click computer',
        '📱': 'phone mobile cell smartphone iphone android tablet ipad screen time device',
        '📲': 'phone mobile call',
        '📺': 'tv television screen watch show movie screen time',
        '📷': 'camera photo picture',
        '📸': 'camera flash photo photography',
        '🎥': 'camera movie film video',
        '📹': 'video camera camcorder',
        '🎮': 'game gaming controller video games xbox playstation nintendo switch',
        '🕹️': 'joystick game arcade',
        '🎧': 'headphones music audio listen',
        '🔋': 'battery power charge',
        '🔌': 'plug electric power',
        '💡': 'lightbulb idea bright',
        '🔦': 'flashlight torch light',
        '📡': 'satellite antenna signal',
        '🔬': 'microscope science lab',
        '🔭': 'telescope space astronomy',
        '⏰': 'alarm clock time wake',
        '⌚': 'watch time wrist',
        '📞': 'telephone phone call',
        '☎️': 'telephone phone call rotary',
        '🧹': 'broom sweep clean floor',
        '🧽': 'sponge wash clean dishes scrub',
        '🧺': 'basket laundry clothes hamper',
        '🧴': 'soap bottle lotion clean',
        '🚿': 'shower bath clean water',
        '🛁': 'bathtub bath clean tub',
        '🚽': 'toilet bathroom restroom clean',
        '🪣': 'bucket pail clean water mop',
        '🧼': 'soap bar clean wash',
        '🧻': 'toilet paper roll bathroom',
        '🪥': 'toothbrush teeth brush dental',
        '🧯': 'fire extinguisher safety',
        '🛒': 'shopping cart grocery store',
        '🗑️': 'trash garbage bin waste delete',
        '♻️': 'recycle recycling green environment',
        '🍽️': 'dishes plate fork knife dinner',
        '🥄': 'spoon utensil eat',
        '🔪': 'knife kitchen cut chop',
        '🍳': 'cooking pan fry egg breakfast',
        '🥘': 'pot cooking food stew',
        '🛏️': 'bed sleep bedroom rest make bed sleepover',
        '🛋️': 'couch sofa living room furniture',
        '🪑': 'chair seat sit furniture',
        '🚪': 'door entrance exit',
        '🪞': 'mirror reflection',
        '🪟': 'window glass',
        '🏠': 'house home building',
        '🏡': 'house home garden yard',
        '👕': 'shirt clothes tshirt laundry',
        '👖': 'pants jeans clothes',
        '🧦': 'socks clothes laundry feet',
        '👔': 'tie shirt clothes formal',
        '🧥': 'coat jacket clothes outerwear',
        '👗': 'dress clothes outfit',
        '👟': 'shoes sneakers running footwear',
        '🌱': 'seedling plant garden grow sprout',
        '🌿': 'herb plant garden leaf',
        '🌳': 'tree nature yard deciduous',
        '🪴': 'potted plant indoor houseplant',
        '🌻': 'sunflower flower garden',
        '🌹': 'rose flower garden red',
        '🌷': 'tulip flower garden',
        '🍀': 'clover lucky four leaf',
        '🍁': 'maple leaf fall autumn',
        '🍂': 'leaves fall autumn',
        '🚗': 'car auto vehicle drive wash',
        '🚙': 'suv car vehicle',
        '🚕': 'taxi cab car',
        '🚌': 'bus transit school',
        '🚲': 'bicycle bike cycle ride',
        '🛴': 'scooter kick',
        '🏍️': 'motorcycle bike',
        '✈️': 'airplane plane flight travel',
        '🚀': 'rocket space launch',
        '🚁': 'helicopter chopper',
        '⛵': 'sailboat boat sailing',
        '🚢': 'ship boat cruise',
        '🐕': 'dog pet puppy walk feed',
        '🐶': 'dog face puppy pet cute',
        '🐈': 'cat pet kitten feed',
        '🐱': 'cat face kitten pet cute',
        '🐠': 'fish pet aquarium tropical',
        '🐟': 'fish pet aquarium',
        '🐦': 'bird pet tweet',
        '🐾': 'paw pet animal print',
        '🐰': 'rabbit bunny pet',
        '🐹': 'hamster pet',
        '🐢': 'turtle tortoise pet slow',
        '📚': 'books school study homework read library',
        '✏️': 'pencil write homework draw',
        '🎒': 'backpack school bag',
        '📝': 'note memo writing homework paper',
        '📖': 'book read study open',
        '🖊️': 'pen write ballpoint',
        '📰': 'newspaper news read',
        '📋': 'clipboard list check',
        '📁': 'folder file organize',
        '📅': 'calendar date schedule',
        '📌': 'pushpin pin',
        '📍': 'pin location map',
        '📎': 'paperclip attach',
        '✂️': 'scissors cut',
        '📏': 'ruler measure straight',
        '📐': 'triangle ruler measure',
        '🔒': 'lock secure closed',
        '🔑': 'key unlock',
        '💼': 'briefcase work business',
        '⚽': 'soccer football ball sport',
        '🏀': 'basketball ball sport hoop',
        '🏈': 'football american sport',
        '⚾': 'baseball ball sport',
        '🎾': 'tennis ball sport racket',
        '🏐': 'volleyball ball sport beach',
        '🏓': 'ping pong table tennis paddle',
        '🏸': 'badminton shuttlecock sport',
        '🎯': 'dart target bullseye goal',
        '🎳': 'bowling ball pins alley',
        '⛳': 'golf flag hole course putt',
        '🏊': 'swimming pool swim water',
        '🚴': 'cycling bike bicycle',
        '🏃': 'running run jog exercise',
        '🧘': 'yoga meditation exercise',
        '🏋️': 'weightlifting gym exercise',
        '🎨': 'art paint palette create',
        '🎭': 'theater drama masks perform',
        '🎬': 'movie film clapperboard cinema theater',
        '🎤': 'microphone sing karaoke music',
        '🎸': 'guitar music instrument rock',
        '🎹': 'piano keyboard music instrument',
        '🥁': 'drum music beat',
        '🎺': 'trumpet music brass',
        '🎷': 'saxophone music jazz',
        '🎻': 'violin music string',
        '⭐': 'star favorite good rating points reward achievement',
        '🌟': 'star glowing bright special reward',
        '✅': 'check done complete success',
        '✔️': 'check mark done',
        '💪': 'strong muscle power flex',
        '🏆': 'trophy win award champion winner prize',
        '🥇': 'gold medal first winner place',
        '🥈': 'silver medal second',
        '🥉': 'bronze medal third',
        '🎖️': 'medal military award',
        '🏅': 'medal sports award',
        '🎉': 'party celebrate confetti celebration popper',
        '🎊': 'confetti ball celebrate',
        '✨': 'sparkle shine clean magic sparkles special shiny',
        '💯': 'hundred percent perfect score',
        '👍': 'thumbs up good like approve',
        '👏': 'clap applause good job',
        '🙌': 'hands raised celebration',
        '💥': 'boom explosion impact',
        '🔥': 'fire hot lit amazing',
        '❤️': 'heart love red',
        '🧡': 'heart love orange',
        '💛': 'heart love yellow',
        '💚': 'heart love green',
        '💙': 'heart love blue',
        '💜': 'heart love purple',
        '🖤': 'heart love black',
        '🤍': 'heart love white',
        '🤎': 'heart love brown',
        '💕': 'hearts love two',
        '💖': 'heart love sparkle',
        '☀️': 'sun sunny weather hot',
        '🌤️': 'sun clouds weather',
        '⛅': 'sun behind cloud weather',
        '🌧️': 'rain cloud weather',
        '⛈️': 'thunder storm weather',
        '❄️': 'snowflake cold winter',
        '🌊': 'wave ocean water',
        '💧': 'water drop droplet',
        '🌈': 'rainbow weather colorful',
        '⚡': 'lightning bolt electric',
        '😀': 'happy smile grin face',
        '😃': 'happy smile big face',
        '😄': 'happy smile laugh face',
        '😊': 'smile happy blush face',
        '😂': 'laugh cry tears joy face',
        '😍': 'love heart eyes face',
        '😎': 'cool sunglasses face',
        '🤓': 'nerd glasses geek face',
        '😴': 'sleep sleeping tired face zzz',
        '🥳': 'party celebrate hat face',
        '🤔': 'thinking hmm face',
        '🥺': 'pleading eyes face please',
        '🎁': 'gift present box wrapped reward prize',
        '🎈': 'balloon party celebrate birthday',
        '🎀': 'ribbon bow gift present',
        '🧸': 'teddy bear toy stuffed animal plush sleepover',
        '🎲': 'dice game roll play board',
        '🧩': 'puzzle piece jigsaw',
        '💎': 'gem diamond jewel sparkle precious',
        '💍': 'ring diamond wedding',
        '👑': 'crown king queen royal princess prince',
        '🔧': 'wrench tool fix',
        '🔨': 'hammer tool build',
        '🛠️': 'tools hammer wrench',
        '🧪': 'test tube science lab',
        '💊': 'pill medicine',
        '🩺': 'stethoscope doctor',
        '🍕': 'pizza food treat reward dinner',
        '🍔': 'hamburger burger food treat reward',
        '🍟': 'fries french fries food treat',
        '🌭': 'hotdog hot dog food treat',
        '🍿': 'popcorn movie snack treat',
        '🍦': 'ice cream cone treat dessert reward',
        '🍨': 'ice cream sundae treat dessert reward',
        '🍩': 'donut doughnut treat snack dessert',
        '🍪': 'cookie treat snack dessert',
        '🧁': 'cupcake treat dessert cake',
        '🍰': 'cake slice treat dessert birthday',
        '🍭': 'lollipop candy treat sweet',
        '🍬': 'candy sweet treat',
        '🍫': 'chocolate candy treat bar',
        '🥤': 'soda drink cup beverage treat',
        '🧋': 'boba bubble tea drink treat',
        '🎢': 'roller coaster amusement park theme park ride fun',
        '🎡': 'ferris wheel amusement park theme park carnival fair',
        '🎠': 'carousel merry go round carnival fair amusement',
        '🎪': 'circus tent carnival big top show sleepover',
        '🛝': 'playground slide park play',
        '🏄': 'surfing surf beach ocean wave',
        '🏖️': 'beach umbrella sand ocean vacation sun',
        '🏝️': 'island beach tropical vacation paradise',
        '🏞️': 'national park nature outdoor hiking',
        '🏕️': 'camping tent outdoor camp',
        '🛍️': 'shopping bags mall store buy',
        '💅': 'nail polish manicure spa beauty',
        '🧖': 'spa sauna steam room relax',
        '♨️': 'hot springs onsen spa',
        '💤': 'sleep sleepover zzz nap rest',
        '🌙': 'moon night sleepover evening',
        '🤿': 'diving snorkeling swimming ocean water',
        '🎣': 'fishing rod fish catch',
        '🛹': 'skateboard skate',
        '🛼': 'roller skate skating rink',
        '🎿': 'skiing ski snow mountain slope',
        '🏂': 'snowboarding snowboard snow mountain',
    },

    open(_anchorId, onSelect) {
        this._onSelect = onSelect;
        this._open = true;
        this._searchQuery = '';
        this._activeCategory = 'frequent';
        App.renderPage();
        // Focus the search field after render
        setTimeout(() => {
            const el = document.getElementById('emoji-search-input');
            if (el) el.focus();
        }, 50);
    },

    close() {
        this._open = false;
        this._onSelect = null;
        App.renderPage();
    },

    select(emoji) {
        const cb = this._onSelect;
        this._open = false;
        this._onSelect = null;
        if (cb) cb(emoji);
    },

    _setCategory(key) {
        this._activeCategory = key;
        this._searchQuery = '';
        const el = document.getElementById('emoji-search-input');
        if (el) el.value = '';
        App.renderPage();
    },

    _onSearch(query) {
        this._searchQuery = query;
        // Re-render just the grid to preserve input focus
        const gridEl = document.getElementById('emoji-grid');
        if (gridEl) gridEl.innerHTML = this._renderGrid();
    },

    _renderGrid() {
        const emojis = this._getVisibleEmojis();
        if (emojis.length === 0) {
            return `<div class="emoji-empty">No emojis found. Try a different search term.</div>`;
        }
        return emojis.map(e =>
            `<button class="emoji-pick-btn" onclick="EmojiPicker.select('${e}')" type="button">${e}</button>`
        ).join('');
    },

    _getVisibleEmojis() {
        const query = (this._searchQuery || '').trim().toLowerCase();
        if (query) {
            // Search across all emojis by keyword/substring
            const allEmojis = Object.values(this.CATEGORIES).flatMap(c => c.emojis);
            const seen = new Set();
            const results = [];
            for (const emoji of allEmojis) {
                if (seen.has(emoji)) continue;
                const keywords = (this.KEYWORDS[emoji] || '').toLowerCase();
                if (emoji.includes(query) || keywords.includes(query)) {
                    results.push(emoji);
                    seen.add(emoji);
                    if (results.length >= this._SEARCH_LIMIT) break;
                }
            }
            return results;
        }
        // Show active category
        return this.CATEGORIES[this._activeCategory]?.emojis || [];
    },

    render() {
        if (!this._open) return '';

        const categoryTabs = Object.entries(this.CATEGORIES).map(([key, cat]) => `
            <button class="emoji-category-tab ${this._activeCategory === key && !this._searchQuery ? 'active' : ''}"
                onclick="EmojiPicker._setCategory('${key}')" title="${cat.name}">
                ${cat.icon}
            </button>
        `).join('');

        return `
            <div class="emoji-picker-backdrop" onclick="EmojiPicker.close()">
                <div class="emoji-picker-popover" onclick="event.stopPropagation()">
                    <div class="emoji-picker-header">
                        <span>Choose an icon</span>
                        <button class="modal-close" onclick="EmojiPicker.close()">✕</button>
                    </div>
                    <div class="emoji-picker-search">
                        <input type="text" id="emoji-search-input"
                            placeholder="Search emojis (e.g. computer, dog, star)..."
                            value="${this._escapeAttr(this._searchQuery)}"
                            oninput="EmojiPicker._onSearch(this.value)">
                    </div>
                    <div class="emoji-category-tabs">${categoryTabs}</div>
                    <div class="emoji-picker-grid" id="emoji-grid">${this._renderGrid()}</div>
                </div>
            </div>
        `;
    },

    _escapeAttr(s) {
        if (!s) return '';
        return String(s).replace(/"/g, '&quot;');
    },
};
