// Electronic drums / percussion — a bank to browse by ear.
//
// Run  :peruse  and it appends an index under each samples() call below. To
// audition: uncomment one peruse_ line, edit the number next to it, and :w to
// hear the next sound. pickmod wraps, so any index is in range — hold a digit.
//
// Sounds are named <machine>_<part>, e.g. RolandTR808_bd, RolandTR909_hh,
// LinnDrum_cp. Parts: bd=kick sd=snare rim=rimshot cp=clap hh=closed-hat
// oh=open-hat cr=crash rd=ride ht/mt/lt=toms cb=cowbell sh=shaker tb=tambourine.
//
// Best electronic machines to look for in the list: RolandTR808, RolandTR909,
// RolandTR606, RolandTR707, LinnDrum, OberheimDMX, EmuSP12, KorgKR55.

// All 71 classic drum machines (TR-808/909/606/707, LinnDrum, DMX, …):
samples('https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json')

// The gritty 12-bit sampler behind the bare bd / hh / sd / cp you get with no bank:
samples('https://raw.githubusercontent.com/felixroos/dough-samples/main/EmuSP12.json')

// --- run :peruse now; the index blocks land below this line ------------------


// Bass here is SYNTHS, not a sample bank, so :peruse can't list it. Uncomment
// one of these to hear the built-in bass voices (edit note/lpf to taste):
//
// note("c2 eb2 g2 c2").s("sawtooth").lpf(600).lpenv(3)         // buzzy filtered
// note("c2 c2 c3 eb2").s("square").lpf(800).resonance(12).lpenv(4).decay(.1)  // acid
// note("c1").s("sine").gain(.9)                                // pure sub
// note("c2 eb2 g2 c3").s("gm_synth_bass_1")                    // GM synth bass
