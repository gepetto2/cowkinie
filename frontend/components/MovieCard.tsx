"use client";

import { Database } from "@/types/database.types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Movie = Database["public"]["Tables"]["movies"]["Row"];

export default function MovieCard({ movie }: { movie: Movie }) {
  return (
    <Dialog>
      {/* DialogTrigger opakowuje plakat. Kliknięcie w niego otworzy modal */}
      <DialogTrigger asChild>
        <div className="flex flex-col group cursor-pointer">
          <div className="relative w-full aspect-[2/3] bg-slate-800 rounded-xl overflow-hidden mb-3 shadow-sm group-hover:shadow-md transition-shadow">
            {movie.poster ? (
              <img src={movie.poster} alt={movie.title} className="object-cover w-full h-full" />
            ) : (
              <div className="flex items-center justify-center w-full h-full text-slate-500 text-xs text-center p-2">Brak plakatu</div>
            )}
          </div>
          <h3 className="font-semibold text-sm leading-tight text-slate-100 line-clamp-2">{movie.title}</h3>
          <p className="text-xs text-slate-400 mt-1">{movie.release_year || ''}</p>
        </div>
      </DialogTrigger>
      
      {/* Zawartość okienka, które się pojawi */}
      <DialogContent className="sm:max-w-[600px] bg-slate-950 border-slate-800 text-slate-50">
        <DialogHeader>
          <DialogTitle className="text-xl">{movie.title}</DialogTitle>
          <DialogDescription className="text-slate-400">
            {movie.director ? `Reżyseria: ${movie.director}` : 'Wybierz miasto, aby zobaczyć godziny seansów.'}
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex flex-col gap-4 py-4">
           {/* W przyszłości wyświetlimy tutaj dynamiczną listę seansów pobraną z bazy */}
           <p className="text-sm text-slate-300">
             Wkrótce dodamy tutaj logikę pobierania godzin seansów z wybranego miasta dla tego filmu!
           </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
