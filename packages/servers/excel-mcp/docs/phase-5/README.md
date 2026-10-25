# Faz 5: biçimlendirme, tablolar ve formüller

Durum: kapsam önerisi. Oluşturma ve düzenleme temeline dayanır; ortak ihtiyaçlar [ana yol haritasındadır](../README.md).

## Hedef

Agent, veriyi kullanıma uygun görünümde sunabilsin ve istenen hesaplama ilişkilerini çalışma kitabına ekleyebilsin.

## Kapsam

| Kimlik | İhtiyaç                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| F5-01  | Sayı, para, yüzde, tarih ve saat görünümünü alttaki değerden ayrı belirlemek.                                                          |
| F5-02  | Yazı tipi, vurgu, renk, kenarlık, hizalama ve metin kaydırma gibi temel görünüm işlemleri.                                             |
| F5-03  | Satır yüksekliği, kolon genişliği, sabit başlıklar, görünürlük ve temel baskı düzeni.                                                  |
| F5-04  | Gerekli durumda birleştirilmiş hücreler oluşturmak/düzenlemek; veri kaybı davranışını belirlemek.                                      |
| F5-05  | Sıradan veri aralığından ayrı olarak Excel tablosu oluşturmak/düzenlemek; başlık, veri, toplam ve filtre davranışını tanımlamak.       |
| F5-06  | Formül eklemek, değiştirmek ve bir alana uygulamak; göreli, mutlak ve sayfalar arası başvuruları ele almak.                            |
| F5-07  | Formül, kaydedilmiş sonuç, hesaplanmamış sonuç ve hesaplama hatasını ayrı ayrı ifade etmek; formülü yazmayı hesaplama olarak sunmamak. |

## Kodlama iş paketleri

1. Değer türü ile görünümün ayrı doğrulanacağı örnekleri ve destek kapsamını belirlemek.
2. Temel hücre biçimleri ve sayfa düzeni işlemlerini eklemek.
3. Excel tablosu oluşturma ve veri aralığı değişimlerini, Faz 3–4 işlemleriyle birlikte ele almak.
4. Formül yazma, kopyalama ve referans davranışlarını tamamlamak.
5. Formül yazıldıktan sonraki hesaplama durumunun doğru bildirilmesini ve kaynak korunarak yeni sürüm üretilmesini doğrulamak. Sunucuda hesaplama motorunu bu iş paketine dahil etmemek.

## Bağımlılıklar ve sınırlar

- Tarihi doğru değer olarak yazmak için Faz 5'i beklemek gerekmez; ilk tarih desteğinin veri anlamı Faz 1'de belirlenir.
- Var olan formülü veya tabloyu korumak, Faz 3'teki düzenlemelerin gereksinimidir.
- Kullanıcı kararıyla bu faz formül yazmaya odaklanır; Excel kurulmadan sunucuda hesaplama ayrı [Faz 6](../phase-6/README.md) kapsamıdır.
- Yeni formül yazabilmek, bütün Excel işlevlerini hesaplayabilmek anlamına gelmez.
- = ile başlayan literal metin ve gerçek formül ayrı niyetlerle yazılabilmelidir.
- Mevcut okuyucunun önbellekteki sonucu okuyabilmesi, son yazılan formülün hesaplandığını kanıtlamaz.
- Taşınan/kopyalanan formülde hangi başvuruların değişeceği ayrı bir davranıştır.
- Grafik, özet tablo ve koşullu biçimlendirme gibi ileri özellikler [Faz 7](../phase-7/README.md) kapsamındadır.

## Kabul senaryoları

- Bir gider raporu tarih ve para görünümüyle hazırlanır; alttaki değerler değişmez.
- Başlık, kolon genişliği ve sabitlenmiş alanlarla okunabilir çıktı elde edilir.
- Bir Excel tablosuna kayıt eklenir; aralık, başlık ve toplam davranışı beklenen duruma gelir.
- Basit toplam ve sayfalar arası formül örnekleri oluşturulur; göreli/mutlak başvurular kontrol edilir.
- Kullanıcı dosyayı aldığında formüllerin hesaplanmış olup olmadığı doğru bildirilir.
- Biçim ve hesaplama iddiaları yalnızca dosyayı yeniden okumaya dayanmadan, gerekli bağımsız içerik/görünüm kontrolleriyle değerlendirilir.

## Açık kararlar

A-09: ilk biçimler, tablo işlemleri, formül sınıfları ve hesaplanmamış sonucun gösterimi. Ayrı hesaplama fazı K1-06 ile kesinleşmiştir; motor ve hesaplama kapsamı A-12 kapsamında Faz 6'da belirlenir. Dinamik diziler, taşan sonuçlar, dış çalışma kitabı başvuruları ve karmaşık işlevler için destek ayrıca belirlenir; tamamı kendiliğinden kapsama girmez.
